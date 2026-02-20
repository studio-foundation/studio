// Main pipeline engine — the orchestrator
// Connects ralph (retry loop) + runner (agent execution) + contracts (validation)

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  StageDefinition,
  PipelineEntry,
  StageGroup,
  PipelineRun,
  StageRun,
  TaskRun,
  AgentRun,
  OutputContract,
  ToolCall,
} from '@studio/contracts';
import { isStageGroup } from '@studio/contracts';
import {
  ralph,
  validateSchema,
  validateToolCalls,
  validateRequiredTools,
  validateCountedTools,
  compose,
  exponentialBackoff,
  fixedDelay,
  noDelay,
  type ExecutionContext as RalphExecutionContext,
  type Validator,
  type ToolCallRequirements,
} from '@studio/ralph';
import {
  runAgent,
  type AgentRunResult,
  type ToolRegistry,
  type ProviderRegistry,
  type TaskInput,
  AnonymizationMiddleware,
} from '@studio/runner';
import { loadPipelineByName } from './pipeline/loader.js';
import { loadAgentProfile } from './pipeline/agent-loader.js';
import { loadContract } from './pipeline/contract-loader.js';
import {
  createInitialContext,
  addStageOutput,
  getContextForStage,
  setGroupFeedback,
  clearGroupFeedback,
  type PipelineContext,
} from './pipeline/context-propagation.js';
import { deriveStageStatus } from './state/status-derivation.js';
import { postValidate, type PostValidationResult } from './pipeline/post-validator.js';
import { loadContextPacks } from './pipeline/context-pack-loader.js';
import type { RunStore } from './state/run-store.js';
import type { EngineEvents, ToolCallSummary } from './events.js';
import { PipelineEventEmitter } from './events.js';

function summarizeOutput(output: unknown): string {
  if (!output || typeof output !== 'object') return 'no structured output';
  const o = output as Record<string, unknown>;
  const keys = Object.keys(o);
  return `${keys.length} fields: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}`;
}

function summarizeToolCalls(toolCalls: ToolCall[]): ToolCallSummary[] {
  return toolCalls.map(tc => ({
    name: tc.name,
    arguments_summary: extractToolArgSummary(tc),
  }));
}

function extractToolArgSummary(tc: ToolCall): string {
  const args = tc.arguments as Record<string, unknown>;
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.length > 0) {
      return value.length > 60 ? value.slice(0, 60) + '...' : value;
    }
  }
  return '';
}

export interface EngineConfig {
  configsDir: string;
  repoPath?: string;
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  db?: RunStore;
  providerOverride?: string;
}

interface ProjectPaths {
  projectDir: string;
  pipelinesDir: string;
  agentsDir: string;
  contractsDir: string;
}

export function parseProjectPipeline(identifier: string): { project: string; pipeline: string } {
  const parts = identifier.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid pipeline identifier '${identifier}'. Expected format: project/pipeline (e.g. 'software/feature-builder')`
    );
  }
  return { project: parts[0], pipeline: parts[1] };
}

function resolveProjectPaths(configsDir: string, project: string): ProjectPaths {
  const projectDir = join(configsDir, project);
  return {
    projectDir,
    pipelinesDir: join(projectDir, 'pipelines'),
    agentsDir: join(projectDir, 'agents'),
    contractsDir: join(projectDir, 'contracts'),
  };
}

export interface RunInput {
  pipeline: string;
  input: string | Record<string, unknown>;
  meta?: Record<string, unknown>;
  anonymize?: boolean;
}

interface StageResult {
  stageRun: StageRun;
  status: string;
  postValidation?: PostValidationResult;
  lastAgentOutput?: unknown;
}

interface GroupResult {
  status: string;
  stageRuns: StageRun[];
  stagesExecuted: number;
  context: PipelineContext;
}

function countTotalStages(entries: PipelineEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (isStageGroup(entry)) {
      count += entry.stages.length;
    } else {
      count++;
    }
  }
  return count;
}

export class PipelineEngine {
  private emitter: PipelineEventEmitter;
  private pipelineTotals = { tokens: 0, toolCalls: 0 };

  constructor(
    private config: EngineConfig,
    private events?: EngineEvents
  ) {
    this.emitter = new PipelineEventEmitter();
  }

  async run(input: RunInput): Promise<PipelineRun> {
    // 1. Parse project/pipeline identifier and resolve paths
    const { project, pipeline: pipelineName } = parseProjectPipeline(input.pipeline);
    const projectPaths = resolveProjectPaths(this.config.configsDir, project);

    // 2. Load the pipeline YAML
    const pipeline = await loadPipelineByName(pipelineName, projectPaths.pipelinesDir);

    // 2. Create the PipelineRun
    const pipelineRun: PipelineRun = {
      id: randomUUID(),
      pipeline_name: pipeline.name,
      status: 'running',
      started_at: new Date().toISOString(),
      stages: [],
    };

    // Reset totals for this run
    this.pipelineTotals = { tokens: 0, toolCalls: 0 };
    const pipelineStartTime = Date.now();

    // Create anonymization middleware for this run if requested via RunInput flag
    const runAnonymize = input.anonymize === true;
    const runMiddleware = runAnonymize ? new AnonymizationMiddleware() : null;

    this.events?.onPipelineStart?.({
      pipeline_name: pipeline.name,
      run_id: pipelineRun.id,
    });
    this.emitter.emit({ type: 'pipeline_start', pipelineId: pipelineRun.id });

    // 3. Initialize context
    const pipelineContext = createInitialContext(input.input, this.config.repoPath);

    // 4. Execute stages sequentially (handling groups)
    const totalStages = countTotalStages(pipeline.stages);
    let stageCounter = 0;
    let previousStageName: string | undefined;

    for (const entry of pipeline.stages) {
      if (isStageGroup(entry)) {
        // ========== GROUP ==========
        const groupResult = await this.runGroup(
          entry,
          pipelineContext,
          stageCounter,
          totalStages,
          input.input,
          projectPaths,
          runMiddleware,
          pipelineRun.id,
        );

        pipelineRun.stages.push(...groupResult.stageRuns);
        stageCounter += groupResult.stagesExecuted;
        // Update previousStageName to the last stage in the group
        if (entry.stages.length > 0) {
          previousStageName = entry.stages[entry.stages.length - 1].name;
        }

        // Clear group feedback after group completes
        clearGroupFeedback(pipelineContext);

        if (groupResult.status === 'rejected' || groupResult.status === 'failed') {
          pipelineRun.status = groupResult.status as any;
          pipelineRun.completed_at = new Date().toISOString();
          this.events?.onPipelineComplete?.({
            pipeline_name: pipeline.name,
            run_id: pipelineRun.id,
            status: pipelineRun.status,
            duration_ms: Date.now() - pipelineStartTime,
            total_tokens: this.pipelineTotals.tokens,
            total_tool_calls: this.pipelineTotals.toolCalls,
          });
          this.emitter.emit({ type: 'pipeline_complete', pipelineId: pipelineRun.id });
          this.config.db?.savePipelineRun(pipelineRun);
          if (runMiddleware) {
            await this.persistKeymap(pipelineRun.id, runMiddleware.getKeymap());
          }
          return pipelineRun;
        }
      } else {
        // ========== SIMPLE STAGE ==========
        stageCounter++;
        const result = await this.executeStage(
          entry,
          pipelineContext,
          previousStageName,
          input.input,
          stageCounter - 1,
          totalStages,
          projectPaths,
          runMiddleware,
          pipelineRun.id,
        );

        pipelineRun.stages.push(result.stageRun);

        if (result.status === 'failed' || result.status === 'rejected') {
          pipelineRun.status = result.stageRun.status;
          pipelineRun.completed_at = new Date().toISOString();
          this.events?.onPipelineComplete?.({
            pipeline_name: pipeline.name,
            run_id: pipelineRun.id,
            status: pipelineRun.status,
            duration_ms: Date.now() - pipelineStartTime,
            total_tokens: this.pipelineTotals.tokens,
            total_tool_calls: this.pipelineTotals.toolCalls,
          });
          this.emitter.emit({ type: 'pipeline_complete', pipelineId: pipelineRun.id });
          this.config.db?.savePipelineRun(pipelineRun);
          if (runMiddleware) {
            await this.persistKeymap(pipelineRun.id, runMiddleware.getKeymap());
          }
          return pipelineRun;
        }

        if (result.lastAgentOutput !== undefined) {
          addStageOutput(pipelineContext, entry.name, result.lastAgentOutput);
        }

        previousStageName = entry.name;
      }
    }

    // 5. All stages succeeded
    pipelineRun.status = 'success';
    pipelineRun.completed_at = new Date().toISOString();

    // 6. Emit + persist
    this.events?.onPipelineComplete?.({
      pipeline_name: pipeline.name,
      run_id: pipelineRun.id,
      status: pipelineRun.status,
      duration_ms: Date.now() - pipelineStartTime,
      total_tokens: this.pipelineTotals.tokens,
      total_tool_calls: this.pipelineTotals.toolCalls,
    });
    this.emitter.emit({ type: 'pipeline_complete', pipelineId: pipelineRun.id });
    this.config.db?.savePipelineRun(pipelineRun);
    if (runMiddleware) {
      await this.persistKeymap(pipelineRun.id, runMiddleware.getKeymap());
    }

    return pipelineRun;
  }

  /** For external listeners via the generic event bus */
  onEvent(listener: (event: import('./events.js').PipelineEvent) => void): void {
    this.emitter.on(listener);
  }

  // -- Private --

  private async executeStage(
    stageDef: StageDefinition,
    pipelineContext: PipelineContext,
    previousStageName: string | undefined,
    userInput: string | Record<string, unknown>,
    stageIndex: number,
    totalStages: number,
    paths: ProjectPaths,
    runMiddleware?: AnonymizationMiddleware | null,
    runId?: string,
  ): Promise<StageResult> {
    const stageRunId = randomUUID();
    const stageStartedAt = new Date().toISOString();

    // Create stage run shell
    const stageRun: StageRun = {
      id: stageRunId,
      stage_name: stageDef.name,
      status: 'running',
      started_at: stageStartedAt,
      tasks: [],
    };

    this.events?.onStageStart?.({
      stage_name: stageDef.name,
      stage_index: stageIndex,
      total_stages: totalStages,
    });
    this.emitter.emit({ type: 'stage_start', stageId: stageRunId, stageName: stageDef.name });

    // Load agent profile
    const agentConfig = await loadAgentProfile(stageDef.agent, paths.agentsDir);
    if (this.config.providerOverride) {
      agentConfig.provider = this.config.providerOverride;
    }

    // Load output contract if specified
    let contract: OutputContract | null = null;
    if (stageDef.contract) {
      const contractName = stageDef.contract.replace('.contract.yaml', '');
      contract = await loadContract(contractName, paths.contractsDir);
    }

    // Build context for this stage
    const agentContext = getContextForStage(pipelineContext, stageDef, previousStageName);

    // Load context packs if stage defines any
    if (stageDef.context?.packs?.length) {
      agentContext.context_packs = await loadContextPacks(
        stageDef.context.packs,
        paths.projectDir,
        pipelineContext.repoPath,
      );
    }

    // Create a single task run (v7: 1 stage = 1 task = 1 ralph call)
    const taskRun: TaskRun = {
      id: randomUUID(),
      task_name: stageDef.name,
      status: 'running',
      started_at: stageStartedAt,
      agent_runs: [],
    };

    // Build the validator for ralph using ralph's own validators
    const ralphValidator = this.buildValidator(contract, stageDef);

    // Resolve retry strategy
    const retryStrategy = this.resolveRetryStrategy(stageDef.ralph?.retry_strategy);

    // Create per-stage middleware if agent requests it (and no run-level middleware)
    const stageMiddleware = (!runMiddleware && agentConfig.anonymize)
      ? new AnonymizationMiddleware()
      : null;

    // Execute ralph loop
    const ralphResult = await ralph<AgentRunResult>({
      executor: async (execContext: RalphExecutionContext) => {
        const agentRunId = randomUUID();
        const agentRunStartedAt = new Date().toISOString();

        const taskInput: TaskInput = {
          description: typeof userInput === 'string' ? userInput : JSON.stringify(userInput),
          stage_kind: stageDef.kind,
          contract_name: contract?.name,
        };

        // Map ralph context to runner context
        const runnerExecContext = {
          attempt: execContext.attempt,
          previous_failures: execContext.previousFailures.map(f => ({
            error: f,
            tool_calls_count: 0,
          })),
        };

        const result = await runAgent({
          agent: agentConfig,
          task: taskInput,
          context: agentContext,
          executionContext: runnerExecContext,
          toolRegistry: this.config.toolRegistry,
          providerRegistry: this.config.providerRegistry,
          outputContract: contract ?? undefined,
          maxToolCalls: stageDef.ralph?.max_tool_calls,
          anonymizationMiddleware: runMiddleware ?? stageMiddleware ?? undefined,
          callbacks: this.events ? {
            onToolCallStart: this.events.onToolCallStart,
            onToolCallComplete: this.events.onToolCallComplete,
          } : undefined,
        });

        // Record agent run
        const agentRun: AgentRun = {
          id: agentRunId,
          agent_name: agentConfig.name,
          attempt: execContext.attempt,
          status: 'success',
          tool_calls: result.tool_calls_count,
          started_at: agentRunStartedAt,
          completed_at: new Date().toISOString(),
          output: result.output,
        };
        taskRun.agent_runs.push(agentRun);

        return result;
      },
      validator: ralphValidator,
      maxAttempts: stageDef.ralph?.max_attempts ?? 3,
      retryStrategy,
      onRetry: async (event) => {
        // Extract raw output for diagnostic logging
        const rawOutput = typeof event.result.output === 'string'
          ? event.result.output
          : JSON.stringify(event.result.output, null, 2);

        this.events?.onTaskRetry?.({
          stage: stageDef.name,
          attempt: event.attempt,
          failures: event.allFailures,
          agent_output_raw: rawOutput,
          tool_calls_count: event.result.tool_calls_count,
        });
        this.emitter.emit({
          type: 'task_retry',
          stageName: stageDef.name,
          attempt: event.attempt,
          failures: event.allFailures,
          rawOutput,
        });
      },
    });

    // Persist stage-level keymap if we created a stage middleware
    if (stageMiddleware) {
      await this.persistKeymap(runId ?? stageRunId, stageMiddleware.getKeymap());
    }

    // Derive stage status from ralph result
    let stageStatus = deriveStageStatus(ralphResult);

    // Post-validation: check if a successful output is semantically rejected
    // (e.g. QA stage returned valid JSON but status says "implementation_incomplete")
    let postResult: PostValidationResult | undefined;
    if (stageStatus === 'success' && contract?.post_validation?.rejection_detection) {
      const agentOutput = ralphResult.status === 'success' ? ralphResult.result?.output : undefined;
      postResult = postValidate(agentOutput, contract);

      if (!postResult.accepted) {
        stageStatus = 'rejected';
      }
    }

    // Finalize task run
    taskRun.status = stageStatus === 'success' ? 'success' : 'failed';
    taskRun.completed_at = new Date().toISOString();

    stageRun.tasks = [taskRun];
    stageRun.status = stageStatus;
    stageRun.completed_at = new Date().toISOString();

    // Extract result data for observability
    const lastResult = ralphResult.status === 'success' ? ralphResult.result : undefined;
    const stageDurationMs = stageRun.completed_at && stageRun.started_at
      ? new Date(stageRun.completed_at).getTime() - new Date(stageRun.started_at).getTime()
      : 0;

    // Accumulate totals
    if (lastResult) {
      this.pipelineTotals.toolCalls += lastResult.tool_calls_count || 0;
      if (lastResult.token_usage) {
        this.pipelineTotals.tokens += lastResult.token_usage.total_tokens;
      }
    }

    this.events?.onStageComplete?.({
      stage_name: stageDef.name,
      stage_index: stageIndex,
      total_stages: totalStages,
      status: stageStatus,
      attempts: ralphResult.attempts,
      duration_ms: stageDurationMs,
      output_summary: stageStatus === 'rejected'
        ? `REJECTED: ${postResult!.rejection_reason}`
        : lastResult ? summarizeOutput(lastResult.output) : undefined,
      output: lastResult?.output,
      tool_calls: lastResult ? summarizeToolCalls(lastResult.tool_calls) : undefined,
      token_usage: lastResult?.token_usage,
      rejection_reason: postResult?.rejection_reason,
      rejection_details: postResult?.rejection_details,
    });
    this.emitter.emit({ type: 'stage_complete', stageId: stageRunId, stageName: stageDef.name });

    return {
      stageRun: stageRun,
      status: stageStatus,
      postValidation: postResult,
      lastAgentOutput: lastResult?.output,
    };
  }

  private async runGroup(
    group: StageGroup,
    context: PipelineContext,
    stageOffset: number,
    totalStages: number,
    userInput: string | Record<string, unknown>,
    paths: ProjectPaths,
    runMiddleware?: AnonymizationMiddleware | null,
    runId?: string,
  ): Promise<GroupResult> {
    const allStageRuns: StageRun[] = [];
    let iteration = 0;

    this.events?.onGroupStart?.({
      group_name: group.group,
      max_iterations: group.max_iterations,
    });
    this.emitter.emit({
      type: 'group_start',
      groupName: group.group,
      maxIterations: group.max_iterations,
    });

    while (iteration < group.max_iterations) {
      iteration++;

      this.events?.onGroupIteration?.({
        group_name: group.group,
        iteration,
        max_iterations: group.max_iterations,
      });
      this.emitter.emit({
        type: 'group_iteration',
        groupName: group.group,
        iteration,
        maxIterations: group.max_iterations,
      });

      let groupSucceeded = true;
      let previousStageName: string | undefined;
      // Find the last stage name before this group in the pipeline context
      for (const [name] of context.stageOutputs) {
        previousStageName = name;
      }

      for (let i = 0; i < group.stages.length; i++) {
        const stage = group.stages[i];
        const stageNumber = stageOffset + i;

        const result = await this.executeStage(
          stage,
          context,
          previousStageName,
          userInput,
          stageNumber,
          totalStages,
          paths,
          runMiddleware,
          runId,
        );

        allStageRuns.push(result.stageRun);

        // Technical failure → stop everything
        if (result.status === 'failed') {
          this.events?.onGroupComplete?.({
            group_name: group.group,
            iterations: iteration,
            status: 'failed',
          });
          this.emitter.emit({
            type: 'group_complete',
            groupName: group.group,
            iterations: iteration,
            status: 'failed',
          });
          return {
            status: 'failed',
            stageRuns: allStageRuns,
            stagesExecuted: group.stages.length,
            context,
          };
        }

        // Propagate output to context (will be cleared if we loop)
        if (result.lastAgentOutput !== undefined) {
          addStageOutput(context, stage.name, result.lastAgentOutput);
        }
        previousStageName = stage.name;

        // Last stage rejected → feedback loop
        const isLastStage = i === group.stages.length - 1;
        if (result.status === 'rejected' && isLastStage) {
          groupSucceeded = false;

          if (iteration < group.max_iterations) {
            // Clear group stage outputs for next iteration
            for (const gs of group.stages) {
              context.stageOutputs.delete(gs.name);
            }

            // Set feedback for next iteration
            setGroupFeedback(context, {
              iteration,
              max_iterations: group.max_iterations,
              rejection_reason: result.postValidation?.rejection_reason || 'Rejected',
              rejection_details: result.postValidation?.rejection_details,
            });

            this.events?.onGroupFeedback?.({
              group_name: group.group,
              iteration,
              rejection_reason: result.postValidation?.rejection_reason || 'Rejected',
              rejection_details: result.postValidation?.rejection_details || [],
            });
            this.emitter.emit({
              type: 'group_feedback',
              groupName: group.group,
              iteration,
              rejectionReason: result.postValidation?.rejection_reason || 'Rejected',
            });
          }

          break; // Exit inner stage loop, retry group
        }

        // Non-gate stage rejected → stop
        if (result.status === 'rejected') {
          this.events?.onGroupComplete?.({
            group_name: group.group,
            iterations: iteration,
            status: 'rejected',
          });
          this.emitter.emit({
            type: 'group_complete',
            groupName: group.group,
            iterations: iteration,
            status: 'rejected',
          });
          return {
            status: 'rejected',
            stageRuns: allStageRuns,
            stagesExecuted: group.stages.length,
            context,
          };
        }
      }

      if (groupSucceeded) {
        this.events?.onGroupComplete?.({
          group_name: group.group,
          iterations: iteration,
          status: 'success',
        });
        this.emitter.emit({
          type: 'group_complete',
          groupName: group.group,
          iterations: iteration,
          status: 'success',
        });
        return {
          status: 'success',
          stageRuns: allStageRuns,
          stagesExecuted: group.stages.length,
          context,
        };
      }
    }

    // Max iterations exhausted
    this.events?.onGroupComplete?.({
      group_name: group.group,
      iterations: iteration,
      status: 'rejected',
    });
    this.emitter.emit({
      type: 'group_complete',
      groupName: group.group,
      iterations: iteration,
      status: 'rejected',
    });
    return {
      status: 'rejected',
      stageRuns: allStageRuns,
      stagesExecuted: group.stages.length,
      context,
    };
  }

  private buildValidator(
    contract: OutputContract | null,
    stageDef: StageDefinition
  ): Validator<AgentRunResult> {
    // No contract → always valid
    if (!contract) {
      return () => ({ valid: true, errors: [], warnings: [] });
    }

    // Compose ralph's built-in validators
    const validators: Validator<AgentRunResult>[] = [];

    // Schema validation (required_fields)
    if (contract.schema?.required_fields) {
      validators.push((result) => validateSchema(result.output, contract));
    }

    // Normalize tool call requirements from contract or stage definition
    const toolCallReqs: ToolCallRequirements | undefined = contract.tool_calls
      ?? (stageDef.tools?.required ? { required_tools: stageDef.tools.required } : undefined);

    // Tool calls count validation
    if (toolCallReqs?.minimum !== undefined || toolCallReqs?.required_tools) {
      validators.push((result) => validateToolCalls(result.tool_calls_count, toolCallReqs));
    }

    // Required tools validation
    if (toolCallReqs?.required_tools?.length) {
      validators.push((result) => validateRequiredTools(result.tool_calls, toolCallReqs));
    }

    // Counted tools validation (OR semantics — any of these count toward minimum)
    if (toolCallReqs?.counted_tools?.length) {
      validators.push((result) => validateCountedTools(result.tool_calls, toolCallReqs));
    }

    if (validators.length === 0) {
      return () => ({ valid: true, errors: [], warnings: [] });
    }

    return compose(...validators);
  }

  private resolveRetryStrategy(strategyName?: string) {
    switch (strategyName) {
      case 'exponential':
        return exponentialBackoff(1000, 30000);
      case 'fixed':
        return fixedDelay(2000);
      case 'none':
      case 'prompt_escalation':
        // Prompt escalation happens in runner via executionContext
        // No delay needed — ralph handles the retry, runner handles the escalation
        return noDelay();
      default:
        return exponentialBackoff(1000, 30000);
    }
  }

  private async persistKeymap(runId: string, keymap: Record<string, string>): Promise<void> {
    if (Object.keys(keymap).length === 0) return;
    try {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      // configsDir is .studio/projects/ — keymap goes in .studio/runs/anonymization/
      const anonDir = join(this.config.configsDir, '..', 'runs', 'anonymization');
      await mkdir(anonDir, { recursive: true });
      const keymapPath = join(anonDir, `${runId}.keymap.json`);
      await writeFile(keymapPath, JSON.stringify(keymap, null, 2), 'utf-8');
    } catch {
      // Non-fatal — keymap persistence is best-effort
    }
  }
}
