// StageExecutor — extracted from PipelineEngine.executeStage()
// Handles the execution of a single pipeline stage: ralph loop, validation, hooks, observability.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  StageDefinition,
  StageRun,
  TaskRun,
  AgentRun,
  OutputContract,
} from '@studio/contracts';
import {
  ralph,
  validateSchema,
  validateToolCalls,
  validateRequiredTools,
  validateCountedTools,
  validateToolGroups,
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
  runScript,
  type AgentRunResult,
  type ToolRegistry,
  type ProviderRegistry,
  type TaskInput,
  AnonymizationMiddleware,
} from '@studio/runner';
import { loadAgentProfile } from './agent-loader.js';
import { loadContract } from './contract-loader.js';
import { loadSkillFiles } from './skill-loader.js';
import { runStageHook, runToolHook } from './hook-executor.js';
import {
  getContextForStage,
  buildContextKeys,
  buildContextContent,
  type PipelineContext,
} from './context-propagation.js';
import { evaluateCondition } from './condition-evaluator.js';
import { deriveStageStatus } from '../state/status-derivation.js';
import { transition } from '../state/state-machine.js';
import { postValidate, type PostValidationResult } from './post-validator.js';
import { loadContextPacks } from './context-pack-loader.js';
import type { EngineEvents, StageContextEvent } from '../events.js';
import { PipelineEventEmitter } from '../events.js';
import type { ProjectPaths, StageResult } from './types.js';

// Module-level helpers — verbatim from engine.ts lines 73-95

function summarizeOutput(output: unknown): string {
  if (!output || typeof output !== 'object') return 'no structured output';
  const o = output as Record<string, unknown>;
  const keys = Object.keys(o);
  return `${keys.length} fields: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}`;
}


export interface StageExecutorConfig {
  events?: EngineEvents;
  emitter: PipelineEventEmitter;
  providerRegistry: ProviderRegistry;
  repoPath?: string;
  configsDir: string;
  pluginSkills?: Record<string, string[]>;
  providerOverride?: string;
}

export class StageExecutor {
  constructor(private config: StageExecutorConfig) {}

  async execute(
    stageDef: StageDefinition,
    pipelineContext: PipelineContext,
    previousStageName: string | undefined,
    userInput: string | Record<string, unknown>,
    stageIndex: number,
    totalStages: number,
    paths: ProjectPaths,
    toolRegistry: ToolRegistry | undefined,
    runMiddleware?: AnonymizationMiddleware | null,
    runId?: string,
    signal?: AbortSignal,
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

    this.config.events?.onStageStart?.({
      stage_name: stageDef.name,
      stage_index: stageIndex,
      total_stages: totalStages,
      max_attempts: stageDef.ralph?.max_attempts ?? 3,
    });
    this.config.emitter.emit({ type: 'stage_start', stageId: stageRunId, stageName: stageDef.name });

    // Evaluate condition — skip stage if false
    if (stageDef.condition !== undefined) {
      const shouldRun = evaluateCondition(stageDef.condition, {
        input: pipelineContext.input,
        stageOutputs: pipelineContext.stageOutputs,
      });
      if (!shouldRun) {
        stageRun.status = 'skipped';
        stageRun.completed_at = new Date().toISOString();
        stageRun.tasks = [];
        this.config.events?.onStageComplete?.({
          stage_name: stageDef.name,
          stage_index: stageIndex,
          total_stages: totalStages,
          status: 'skipped',
          attempts: 0,
          duration_ms: 0,
        });
        this.config.emitter.emit({ type: 'stage_complete', stageId: stageRunId, stageName: stageDef.name });
        return { stageRun, status: 'skipped' };
      }
    }

    // Load agent profile — only for LLM stages (script stages have no agent)
    let agentConfig: Awaited<ReturnType<typeof loadAgentProfile>> | null = null;
    if (stageDef.agent) {
      agentConfig = await loadAgentProfile(stageDef.agent, paths.agentsDir);
      if (this.config.providerOverride) {
        agentConfig.provider = this.config.providerOverride;
      }
      // Inject plugin skills into system_prompt for agents that declare plugins
      if (agentConfig.plugins?.length && this.config.pluginSkills) {
        const skillChunks = agentConfig.plugins
          .flatMap((p) => this.config.pluginSkills![p] ?? []);
        if (skillChunks.length > 0) {
          agentConfig.system_prompt = `${agentConfig.system_prompt ?? ''}\n\n${skillChunks.join('\n\n---\n\n')}`;
        }
      }

      // Inject project skills (.studio/skills/*.skill.md) for agents that declare skills
      if (agentConfig.skills?.length) {
        const skillsDir = join(paths.projectDir, 'skills');
        const loaded = await loadSkillFiles(agentConfig.skills, skillsDir);
        if (loaded.length > 0) {
          const skillChunks = loaded.map((s) => `## Skill: ${s.name}\n\n${s.content}`);
          agentConfig.system_prompt = `${agentConfig.system_prompt ?? ''}\n\n${skillChunks.join('\n\n---\n\n')}`;
        }
      }

      // Inject project domain invariants (.studio/invariants.md) into system_prompt
      if (pipelineContext.invariantsContent) {
        agentConfig.system_prompt = `${agentConfig.system_prompt ?? ''}\n\n---\n\n## Project Invariants\n\n${pipelineContext.invariantsContent}`;
      }
    }

    // Validate: stage must have either agent (LLM) or script (script executor)
    if (!stageDef.agent && !stageDef.script) {
      throw new Error(`Stage '${stageDef.name}' must have either 'agent' (for LLM) or 'script' (for script executor)`);
    }

    const stageHooks = stageDef.hooks;
    const hookCwd = this.config.repoPath ?? this.config.configsDir;

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

    // Emit context observability event (zero work if no handler registered)
    if (this.config.events?.onStageContext) {
      const debugFlag = process.env.DEBUG ?? '';
      const includeContent = debugFlag.includes('studio:context');
      const includePrompt  = debugFlag.includes('studio:context:verbose');

      const contextEvent: StageContextEvent = {
        stage: stageDef.name,
        run_id: runId ?? '',
        context_keys: buildContextKeys(agentContext, pipelineContext.stageOutputSizes),
        ...(includeContent ? { context_content: buildContextContent(agentContext) } : {}),
        ...(includePrompt && agentConfig ? { system_prompt: agentConfig.system_prompt } : {}),
      };

      this.config.events.onStageContext(contextEvent);
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
    const stageMiddleware = (!runMiddleware && agentConfig?.anonymize)
      ? new AnonymizationMiddleware()
      : null;

    // Run on_stage_start hooks before the ralph loop
    if (stageHooks?.on_stage_start?.length) {
      for (const hook of stageHooks.on_stage_start) {
        const hookResult = await runStageHook(hook, hookCwd);
        if (!hookResult.success) {
          const onFailure = hook.on_failure ?? 'warn';
          if (onFailure === 'fail') {
            stageRun.status = 'failed';
            stageRun.completed_at = new Date().toISOString();
            stageRun.tasks = [];
            this.config.events?.onStageComplete?.({
              stage_name: stageDef.name,
              stage_index: stageIndex,
              total_stages: totalStages,
              status: 'failed',
              attempts: 0,
              duration_ms: Date.now() - new Date(stageStartedAt).getTime(),
            });
            this.config.emitter.emit({ type: 'stage_complete', stageId: stageRunId, stageName: stageDef.name });
            return { stageRun, status: 'failed' };
          } else if (onFailure === 'reject') {
            stageRun.status = 'rejected';
            stageRun.completed_at = new Date().toISOString();
            stageRun.tasks = [];
            this.config.events?.onStageComplete?.({
              stage_name: stageDef.name,
              stage_index: stageIndex,
              total_stages: totalStages,
              status: 'rejected',
              attempts: 0,
              duration_ms: Date.now() - new Date(stageStartedAt).getTime(),
            });
            this.config.emitter.emit({ type: 'stage_complete', stageId: stageRunId, stageName: stageDef.name });
            return {
              stageRun,
              status: 'rejected',
              postValidation: {
                accepted: false,
                rejection_reason: `on_stage_start hook failed: ${hook.command}`,
                rejection_details: hookResult.stderr ? [hookResult.stderr] : [],
              },
            };
          } else {
            // warn (default)
            console.warn(`[on_stage_start] hook failed for stage "${stageDef.name}": ${hookResult.stderr}`);
          }
        }
      }
    }

    // Build tool hook callbacks for runAgent
    const onPreToolUse = stageHooks?.pre_tool_use?.length
      ? async (event: { tool: string; params: Record<string, unknown>; timestamp: number }) => {
          const matchingHooks = stageHooks!.pre_tool_use!.filter(h => h.matcher === event.tool);
          // Fail-fast: first matching hook that fails blocks the tool call; remaining hooks are skipped
          for (const hook of matchingHooks) {
            const hookResult = await runToolHook(hook, event.params, hookCwd);
            if (!hookResult.success) {
              return { blocked: true, error: `Pre-hook failed: ${hookResult.stderr || hookResult.stdout}` };
            }
          }
          return { blocked: false };
        }
      : undefined;

    const onPostToolUse = stageHooks?.post_tool_use?.length
      ? async (event: { tool: string; params: Record<string, unknown>; result: unknown; error?: string; timestamp: number }) => {
          const matchingHooks = stageHooks!.post_tool_use!.filter(h => h.matcher === event.tool);
          for (const hook of matchingHooks) {
            const hookResult = await runToolHook(hook, event.params, hookCwd);
            if (!hookResult.success) {
              const onFailure = hook.on_failure ?? 'warn';
              if (onFailure === 'reject') {
                return { append_message: `Post-hook failed: ${hookResult.stderr || hookResult.stdout}` };
              } else {
                console.warn(`[post_tool_use] hook failed for "${event.tool}" in stage "${stageDef.name}": ${hookResult.stderr}`);
              }
            }
          }
          return {};
        }
      : undefined;

    // Execute ralph loop — catch unexpected executor throws (network errors, etc.)
    // and convert them to a failed stage rather than crashing the pipeline.
    let ralphResult: Awaited<ReturnType<typeof ralph<AgentRunResult>>>;
    try {
      ralphResult = await ralph<AgentRunResult>({
      executor: async (execContext: RalphExecutionContext) => {
        const agentRunId = randomUUID();
        const agentRunStartedAt = new Date().toISOString();

        const taskInput: TaskInput = {
          description: typeof userInput === 'string' ? userInput : JSON.stringify(userInput),
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

        const result = stageDef.agent
          ? await runAgent({
              agent: agentConfig!,
              task: taskInput,
              context: agentContext,
              executionContext: runnerExecContext,
              toolRegistry: toolRegistry!,
              providerRegistry: this.config.providerRegistry,
              outputContract: contract ?? undefined,
              maxToolCalls: stageDef.ralph?.max_tool_calls,
              anonymizationMiddleware: runMiddleware ?? stageMiddleware ?? undefined,
              signal,
              callbacks: {
                ...(this.config.events ? {
                  onToolCallStart: this.config.events.onToolCallStart
                    ? (e) => this.config.events!.onToolCallStart!({ stage: stageDef.name, ...e })
                    : undefined,
                  onToolCallComplete: this.config.events.onToolCallComplete
                    ? (e) => this.config.events!.onToolCallComplete!({ stage: stageDef.name, ...e })
                    : undefined,
                  onAgentThinking: this.config.events.onAgentThinking
                    ? (e) => this.config.events!.onAgentThinking!({ stage: stageDef.name, ...e })
                    : undefined,
                  onAgentProgress: this.config.events.onAgentProgress
                    ? (e) => this.config.events!.onAgentProgress!({ stage: stageDef.name, ...e })
                    : undefined,
                  onAgentToken: this.config.events.onAgentToken
                    ? (e) => this.config.events!.onAgentToken!({ stage: stageDef.name, ...e })
                    : undefined,
                } : {}),
                ...(onPreToolUse ? { onPreToolUse } : {}),
                ...(onPostToolUse ? { onPostToolUse } : {}),
              },
            })
          : await runScript({
              scriptPath: stageDef.script!,
              runtime: stageDef.runtime ?? 'shell',
              context: agentContext,
              cwd: this.config.repoPath ?? this.config.configsDir,
              timeoutMs: stageDef.timeout_ms,
            });

        // Record agent run
        const agentRun: AgentRun = {
          id: agentRunId,
          agent_name: agentConfig?.name ?? `script:${stageDef.script ?? 'unknown'}`,
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
      signal,
      onRetry: async (event) => {
        // Extract raw output for diagnostic logging
        const rawOutput = typeof event.result.output === 'string'
          ? event.result.output
          : JSON.stringify(event.result.output, null, 2);

        this.config.events?.onTaskRetry?.({
          stage: stageDef.name,
          attempt: event.attempt,
          max_attempts: stageDef.ralph?.max_attempts ?? 3,
          failures: event.allFailures,
          agent_output_raw: rawOutput,
          tool_calls_count: event.result.tool_calls_count,
        });
        this.config.emitter.emit({
          type: 'task_retry',
          stageName: stageDef.name,
          attempt: event.attempt,
          failures: event.allFailures,
          rawOutput,
        });
      },
      });
    } catch (err) {
      // AbortError from signal propagation is handled inside ralph (returns 'cancelled').
      // Any other throw is a technical failure (network, timeout, etc.) — mark stage failed.
      stageRun.status = transition('running', 'fail');
      stageRun.completed_at = new Date().toISOString();
      stageRun.tasks = [taskRun];
      this.config.events?.onStageComplete?.({
        stage_name: stageDef.name,
        stage_index: stageIndex,
        total_stages: totalStages,
        status: 'failed',
        attempts: 1,
        duration_ms: Date.now() - new Date(stageStartedAt).getTime(),
      });
      this.config.emitter.emit({ type: 'stage_complete', stageId: stageRunId, stageName: stageDef.name });
      return { stageRun, status: 'failed' };
    }

    // Persist stage-level keymap if we created a stage middleware
    if (stageMiddleware) {
      await this.persistKeymap(runId ?? stageRunId, stageMiddleware.getKeymap());
    }

    // Derive stage status from ralph result
    let stageStatus = deriveStageStatus(ralphResult);

    // Cancelled — skip post-validation and hooks
    if (stageStatus === 'cancelled') {
      stageRun.status = transition('running', 'cancel');
      stageRun.completed_at = new Date().toISOString();
      taskRun.status = 'failed'; // closest existing TaskRun status
      taskRun.completed_at = new Date().toISOString();
      stageRun.tasks = [taskRun];
      this.config.events?.onStageComplete?.({
        stage_name: stageDef.name,
        stage_index: stageIndex,
        total_stages: totalStages,
        status: 'cancelled',
        attempts: ralphResult.attempts,
        duration_ms: Date.now() - new Date(stageStartedAt).getTime(),
      });
      this.config.emitter.emit({ type: 'stage_complete', stageId: stageRunId, stageName: stageDef.name });
      return { stageRun, status: 'cancelled' };
    }

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

    // Run on_stage_complete hooks — only when stage succeeded (including post-validation)
    if (stageStatus === 'success' && stageHooks?.on_stage_complete?.length) {
      const stageOutput = ralphResult.status === 'success'
        ? (ralphResult.result?.output as Record<string, unknown> ?? {})
        : {};
      for (const hook of stageHooks.on_stage_complete) {
        const hookResult = await runStageHook(hook, hookCwd, stageOutput);
        if (!hookResult.success) {
          const onFailure = hook.on_failure ?? 'warn';
          if (onFailure === 'reject') {
            stageStatus = 'rejected';
            postResult = {
              accepted: false,
              rejection_reason: `on_stage_complete hook failed: ${hook.command}`,
              rejection_details: hookResult.stderr ? [hookResult.stderr] : [],
            };
            break;
          } else if (onFailure === 'fail') {
            stageStatus = 'failed';
            postResult = {
              accepted: false,
              rejection_reason: `on_stage_complete hook failed: ${hook.command}`,
              rejection_details: hookResult.stderr ? [hookResult.stderr] : [],
            };
            break;
          } else {
            // warn (default)
            console.warn(`[on_stage_complete] hook failed for stage "${stageDef.name}": ${hookResult.stderr}`);
          }
        }
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

    // Populate stage output for observability and context propagation
    if (lastResult?.output !== undefined) {
      stageRun.output = lastResult.output;
    }
    const stageDurationMs = stageRun.completed_at && stageRun.started_at
      ? new Date(stageRun.completed_at).getTime() - new Date(stageRun.started_at).getTime()
      : 0;

    this.config.events?.onStageComplete?.({
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
      tool_calls: lastResult ? lastResult.tool_calls : undefined,
      token_usage: lastResult?.token_usage,
      rejection_reason: postResult?.rejection_reason,
      rejection_details: postResult?.rejection_details,
    });
    this.config.emitter.emit({ type: 'stage_complete', stageId: stageRunId, stageName: stageDef.name });

    return {
      stageRun: stageRun,
      status: stageStatus,
      postValidation: postResult,
      lastAgentOutput: lastResult?.output,
      toolCalls: lastResult?.tool_calls,
      tokensDelta: lastResult?.token_usage?.total_tokens ?? 0,
      toolCallsDelta: lastResult?.tool_calls_count ?? 0,
    };
  }

  private buildValidator(
    contract: OutputContract | null,
    stageDef: StageDefinition
  ): Validator<AgentRunResult> {
    // Always fail if runner returned a terminal error (e.g. max tool iterations)
    const errorCheck: Validator<AgentRunResult> = (result) =>
      result.error
        ? { valid: false, errors: [result.error], warnings: [] }
        : { valid: true, errors: [], warnings: [] };

    // No contract → only the error check applies
    if (!contract) {
      return errorCheck;
    }

    // Compose ralph's built-in validators
    const validators: Validator<AgentRunResult>[] = [errorCheck];

    // Schema validation (required_fields)
    if (contract.schema?.required_fields) {
      validators.push((result) => validateSchema(result.output, contract));
    }

    // Normalize tool call requirements from contract or stage definition
    const toolCallReqs: ToolCallRequirements | undefined = contract.tool_calls
      ?? (stageDef.tools?.required ? { required_tools: stageDef.tools.required } : undefined);

    // Tool calls count validation
    if (toolCallReqs?.minimum !== undefined || toolCallReqs?.maximum !== undefined || toolCallReqs?.required_tools) {
      validators.push((result) => validateToolCalls(result.tool_calls, toolCallReqs));
    }

    // Required tools validation
    if (toolCallReqs?.required_tools?.length) {
      validators.push((result) => validateRequiredTools(result.tool_calls, toolCallReqs));
    }

    // Counted tools validation (OR semantics — any of these count toward minimum)
    if (toolCallReqs?.counted_tools?.length) {
      validators.push((result) => validateCountedTools(result.tool_calls, toolCallReqs));
    }

    // Tool groups validation (OR per group — at least one tool from each group must be called)
    if (toolCallReqs?.required_tool_groups?.length) {
      validators.push((result) => validateToolGroups(result.tool_calls, toolCallReqs));
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
      // configsDir is .studio/ directly — keymap goes in .studio/runs/anonymization/
      const anonDir = join(this.config.configsDir, 'runs', 'anonymization');
      await mkdir(anonDir, { recursive: true });
      const keymapPath = join(anonDir, `${runId}.keymap.json`);
      await writeFile(keymapPath, JSON.stringify(keymap, null, 2), 'utf-8');
    } catch {
      // Non-fatal — keymap persistence is best-effort
    }
  }
}
