// Main pipeline engine — the orchestrator
// Connects ralph (retry loop) + runner (agent execution) + contracts (validation)

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  StageDefinition,
  PipelineEntry,
  StageGroup,
  PipelineRun,
  PipelineDefinition,
  StageRun,
  TaskRun,
  AgentRun,
  OutputContract,
  ToolCall,
  RunSpawner,
  StageStatus,
} from '@studio/contracts';
import { isStageGroup } from '@studio/contracts';
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
  createStudioRunTool,
  STUDIO_RUN_PROMPT_SNIPPET,
} from '@studio/runner';
import { loadPipelineByName } from './pipeline/loader.js';
import { loadAgentProfile } from './pipeline/agent-loader.js';
import { loadContract } from './pipeline/contract-loader.js';
import { loadSkillFiles } from './pipeline/skill-loader.js';
import { executeStartupCommands } from './pipeline/startup-executor.js';
import { loadInvariantsFile } from './pipeline/invariants-loader.js';
import { runStageHook, runToolHook } from './pipeline/hook-executor.js';
import {
  createInitialContext,
  addStageOutput,
  addStageToolResults,
  getContextForStage,
  setGroupFeedback,
  clearGroupFeedback,
  buildContextKeys,
  buildContextContent,
  type PipelineContext,
} from './pipeline/context-propagation.js';
import { deriveStageStatus } from './state/status-derivation.js';
import { postValidate, type PostValidationResult } from './pipeline/post-validator.js';
import { loadContextPacks } from './pipeline/context-pack-loader.js';
import type { AnyRunStore } from './state/run-store.js';
import type { EngineEvents, ToolCallSummary, StageContextEvent } from './events.js';
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
  toolRegistry?: ToolRegistry;  // optional — not needed for script-only pipelines
  db?: AnyRunStore;
  providerOverride?: string;
  /**
   * Skills content from active plugins, keyed by plugin name.
   * Each entry is an array of formatted markdown strings to inject
   * into the system prompt of agents that declare the plugin.
   */
  pluginSkills?: Record<string, string[]>;
  spawner?: RunSpawner;  // if set, studio-run tool is available to agents
  maxDepth?: number;     // max nesting depth for spawned runs, default 3
}

interface ProjectPaths {
  projectDir: string;
  pipelinesDir: string;
  agentsDir: string;
  contractsDir: string;
}

function resolveProjectPaths(configsDir: string): ProjectPaths {
  return {
    projectDir: configsDir,
    pipelinesDir: join(configsDir, 'pipelines'),
    agentsDir: join(configsDir, 'agents'),
    contractsDir: join(configsDir, 'contracts'),
  };
}

export interface RunInput {
  id?: string;          // ← pre-generated run ID (e.g. from the API)
  pipeline?: string;    // pipeline name (loads from YAML file)
  pipelineDef?: PipelineDefinition; // inline pipeline definition (skips YAML loading — for tests/programmatic use)
  input?: string | Record<string, unknown>;
  userInput?: string | Record<string, unknown>; // alias for input (used in tests and programmatic API)
  meta?: Record<string, unknown>;
  anonymize?: boolean;
  signal?: AbortSignal;
  depth?: number;        // nesting depth (0 = top-level)
  parentRunId?: string;  // parent run ID if spawned by another pipeline
}

interface StageResult {
  stageRun: StageRun;
  status: StageStatus;
  postValidation?: PostValidationResult;
  lastAgentOutput?: unknown;
  toolCalls?: ToolCall[];
}

interface GroupResult {
  status: StageStatus;
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
    const signal = input.signal;

    // Resolve the effective user input (support both 'input' and 'userInput' aliases)
    const userInputValue: string | Record<string, unknown> = input.userInput ?? input.input ?? '';

    if (!input.pipeline && !input.pipelineDef) {
      throw new Error('RunInput must provide either "pipeline" (pipeline name) or "pipelineDef" (inline definition)');
    }

    // 1. Resolve paths — configsDir is now the project root directly
    const projectPaths = resolveProjectPaths(this.config.configsDir);

    // 2. Load the pipeline — either from an inline definition or a YAML file
    const pipeline: PipelineDefinition = input.pipelineDef
      ? input.pipelineDef
      : await loadPipelineByName(input.pipeline!, projectPaths.pipelinesDir);

    // 2. Create the PipelineRun
    const pipelineRun: PipelineRun = {
      id: input.id ?? randomUUID(),
      pipeline_name: pipeline.name,
      status: 'running',
      started_at: new Date().toISOString(),
      stages: [],
      ...(typeof userInputValue === 'object' && userInputValue !== null
        ? { input: userInputValue as Record<string, unknown> }
        : {}),
      ...(input.parentRunId ? { parent_run_id: input.parentRunId } : {}),
    };

    // Reset totals for this run
    this.pipelineTotals = { tokens: 0, toolCalls: 0 };
    const pipelineStartTime = Date.now();

    // Create anonymization middleware for this run if requested via RunInput flag
    const runAnonymize = input.anonymize === true;
    const runMiddleware = runAnonymize ? new AnonymizationMiddleware() : null;

    // Persist the run immediately so log_path can be written before terminal states
    await this.config.db?.savePipelineRun(pipelineRun);

    // Build per-run tool registry: clone the shared registry and inject studio-run
    // with run-specific context (run ID, depth) if a spawner is configured.
    // For script-only pipelines, toolRegistry may be undefined.
    const runToolRegistry = this.config.spawner && this.config.toolRegistry
      ? (() => {
          const registry = this.config.toolRegistry.clone();
          registry.registerPlugin(
            'studio_run',
            createStudioRunTool({
              spawner: this.config.spawner!,
              currentRunId: pipelineRun.id,
              currentDepth: input.depth ?? 0,
              maxDepth: this.config.maxDepth ?? 3,
            }),
            STUDIO_RUN_PROMPT_SNIPPET
          );
          return registry;
        })()
      : this.config.toolRegistry;

    this.events?.onPipelineStart?.({
      pipeline_name: pipeline.name,
      run_id: pipelineRun.id,
    });
    this.emitter.emit({ type: 'pipeline_start', pipelineId: pipelineRun.id });

    // 3. Initialize context
    const pipelineContext = createInitialContext(userInputValue, this.config.repoPath);

    // Run on_pipeline_start commands to bootstrap dynamic context
    if (pipeline.on_pipeline_start?.length) {
      const cwd = this.config.repoPath ?? this.config.configsDir;
      pipelineContext.startupContext = await executeStartupCommands(
        pipeline.on_pipeline_start,
        cwd
      );
    }

    // Load .studio/invariants.md if present — injected into every agent's system_prompt
    pipelineContext.invariantsContent = await loadInvariantsFile(projectPaths.projectDir);

    // 4. Execute stages sequentially (handling groups)
    const totalStages = countTotalStages(pipeline.stages);
    let stageCounter = 0;
    let previousStageName: string | undefined;

    for (const entry of pipeline.stages) {
      // Check for cancellation before each pipeline entry
      if (signal?.aborted) {
        pipelineRun.status = 'cancelled';
        pipelineRun.completed_at = new Date().toISOString();
        const lastStage = pipelineRun.stages[pipelineRun.stages.length - 1];
        this.events?.onPipelineCancelled?.({
          run_id: pipelineRun.id,
          cancelled_at_stage: lastStage?.stage_name ?? 'before_first_stage',
          duration_ms: Date.now() - pipelineStartTime,
        });
        this.events?.onPipelineComplete?.({
          pipeline_name: pipeline.name,
          run_id: pipelineRun.id,
          status: 'cancelled',
          duration_ms: Date.now() - pipelineStartTime,
          total_tokens: this.pipelineTotals.tokens,
          total_tool_calls: this.pipelineTotals.toolCalls,
        });
        this.emitter.emit({ type: 'pipeline_complete', pipelineId: pipelineRun.id });
        await this.config.db?.savePipelineRun(pipelineRun);
        return pipelineRun;
      }

      if (isStageGroup(entry)) {
        // ========== GROUP ==========
        const groupResult = await this.runGroup(
          entry,
          pipelineContext,
          stageCounter,
          totalStages,
          userInputValue,
          projectPaths,
          runToolRegistry,
          runMiddleware,
          pipelineRun.id,
          signal,
        );

        pipelineRun.stages.push(...groupResult.stageRuns);
        stageCounter += groupResult.stagesExecuted;
        // Update previousStageName to the last stage in the group
        if (entry.stages.length > 0) {
          previousStageName = entry.stages[entry.stages.length - 1].name;
        }

        // Clear group feedback after group completes
        clearGroupFeedback(pipelineContext);

        if (groupResult.status === 'rejected' || groupResult.status === 'failed' || groupResult.status === 'cancelled') {
          pipelineRun.status = groupResult.status;
          pipelineRun.completed_at = new Date().toISOString();
          if (groupResult.status === 'cancelled') {
            const lastStage = pipelineRun.stages[pipelineRun.stages.length - 1];
            this.events?.onPipelineCancelled?.({
              run_id: pipelineRun.id,
              cancelled_at_stage: lastStage?.stage_name ?? 'unknown',
              duration_ms: Date.now() - pipelineStartTime,
            });
          }
          this.events?.onPipelineComplete?.({
            pipeline_name: pipeline.name,
            run_id: pipelineRun.id,
            status: pipelineRun.status,
            duration_ms: Date.now() - pipelineStartTime,
            total_tokens: this.pipelineTotals.tokens,
            total_tool_calls: this.pipelineTotals.toolCalls,
          });
          this.emitter.emit({ type: 'pipeline_complete', pipelineId: pipelineRun.id });
          await this.config.db?.savePipelineRun(pipelineRun);
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
          userInputValue,
          stageCounter - 1,
          totalStages,
          projectPaths,
          runToolRegistry,
          runMiddleware,
          pipelineRun.id,
          signal,
        );

        pipelineRun.stages.push(result.stageRun);

        if (result.status === 'failed' || result.status === 'rejected' || result.status === 'cancelled') {
          pipelineRun.status = result.stageRun.status;
          pipelineRun.completed_at = new Date().toISOString();
          if (result.status === 'cancelled') {
            this.events?.onPipelineCancelled?.({
              run_id: pipelineRun.id,
              cancelled_at_stage: result.stageRun.stage_name,
              duration_ms: Date.now() - pipelineStartTime,
            });
          }
          this.events?.onPipelineComplete?.({
            pipeline_name: pipeline.name,
            run_id: pipelineRun.id,
            status: pipelineRun.status,
            duration_ms: Date.now() - pipelineStartTime,
            total_tokens: this.pipelineTotals.tokens,
            total_tool_calls: this.pipelineTotals.toolCalls,
          });
          this.emitter.emit({ type: 'pipeline_complete', pipelineId: pipelineRun.id });
          await this.config.db?.savePipelineRun(pipelineRun);
          if (runMiddleware) {
            await this.persistKeymap(pipelineRun.id, runMiddleware.getKeymap());
          }
          return pipelineRun;
        }

        if (result.lastAgentOutput !== undefined) {
          addStageOutput(pipelineContext, entry.name, result.lastAgentOutput);
        }
        if (result.toolCalls && result.toolCalls.length > 0) {
          addStageToolResults(pipelineContext, entry.name, result.toolCalls);
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
    await this.config.db?.savePipelineRun(pipelineRun);
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

    this.events?.onStageStart?.({
      stage_name: stageDef.name,
      stage_index: stageIndex,
      total_stages: totalStages,
      max_attempts: stageDef.ralph?.max_attempts ?? 3,
    });
    this.emitter.emit({ type: 'stage_start', stageId: stageRunId, stageName: stageDef.name });

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
    if (this.events?.onStageContext) {
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

      this.events.onStageContext(contextEvent);
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
            this.events?.onStageComplete?.({
              stage_name: stageDef.name,
              stage_index: stageIndex,
              total_stages: totalStages,
              status: 'failed',
              attempts: 0,
              duration_ms: Date.now() - new Date(stageStartedAt).getTime(),
            });
            this.emitter.emit({ type: 'stage_complete', stageId: stageRunId, stageName: stageDef.name });
            return { stageRun, status: 'failed' };
          } else if (onFailure === 'reject') {
            stageRun.status = 'rejected';
            stageRun.completed_at = new Date().toISOString();
            stageRun.tasks = [];
            this.events?.onStageComplete?.({
              stage_name: stageDef.name,
              stage_index: stageIndex,
              total_stages: totalStages,
              status: 'rejected',
              attempts: 0,
              duration_ms: Date.now() - new Date(stageStartedAt).getTime(),
            });
            this.emitter.emit({ type: 'stage_complete', stageId: stageRunId, stageName: stageDef.name });
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

    // Execute ralph loop
    const ralphResult = await ralph<AgentRunResult>({
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
                ...(this.events ? {
                  onToolCallStart: this.events.onToolCallStart
                    ? (e) => this.events!.onToolCallStart!({ stage: stageDef.name, ...e })
                    : undefined,
                  onToolCallComplete: this.events.onToolCallComplete
                    ? (e) => this.events!.onToolCallComplete!({ stage: stageDef.name, ...e })
                    : undefined,
                  onAgentThinking: this.events.onAgentThinking
                    ? (e) => this.events!.onAgentThinking!({ stage: stageDef.name, ...e })
                    : undefined,
                  onAgentProgress: this.events.onAgentProgress
                    ? (e) => this.events!.onAgentProgress!({ stage: stageDef.name, ...e })
                    : undefined,
                  onAgentToken: this.events.onAgentToken
                    ? (e) => this.events!.onAgentToken!({ stage: stageDef.name, ...e })
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

        this.events?.onTaskRetry?.({
          stage: stageDef.name,
          attempt: event.attempt,
          max_attempts: stageDef.ralph?.max_attempts ?? 3,
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

    // Cancelled — skip post-validation and hooks
    if (stageStatus === 'cancelled') {
      stageRun.status = 'cancelled';
      stageRun.completed_at = new Date().toISOString();
      taskRun.status = 'failed'; // closest existing TaskRun status
      taskRun.completed_at = new Date().toISOString();
      stageRun.tasks = [taskRun];
      this.events?.onStageComplete?.({
        stage_name: stageDef.name,
        stage_index: stageIndex,
        total_stages: totalStages,
        status: 'cancelled',
        attempts: ralphResult.attempts,
        duration_ms: Date.now() - new Date(stageStartedAt).getTime(),
      });
      this.emitter.emit({ type: 'stage_complete', stageId: stageRunId, stageName: stageDef.name });
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
      toolCalls: lastResult?.tool_calls,
    };
  }

  private async runGroup(
    group: StageGroup,
    context: PipelineContext,
    stageOffset: number,
    totalStages: number,
    userInput: string | Record<string, unknown>,
    paths: ProjectPaths,
    toolRegistry: ToolRegistry | undefined,
    runMiddleware?: AnonymizationMiddleware | null,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<GroupResult> {
    if (group.mode === 'parallel') {
      return this.runGroupParallel(group, context, stageOffset, totalStages, userInput, paths, toolRegistry, runMiddleware, runId, signal);
    }
    return this.runGroupSequential(group, context, stageOffset, totalStages, userInput, paths, toolRegistry, runMiddleware, runId, signal);
  }

  private async runGroupParallel(
    group: StageGroup,
    context: PipelineContext,
    stageOffset: number,
    totalStages: number,
    userInput: string | Record<string, unknown>,
    paths: ProjectPaths,
    toolRegistry: ToolRegistry | undefined,
    runMiddleware?: AnonymizationMiddleware | null,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<GroupResult> {
    this.events?.onGroupStart?.({
      group_name: group.group,
      max_iterations: group.max_iterations,
    });
    this.emitter.emit({
      type: 'group_start',
      groupName: group.group,
      maxIterations: group.max_iterations,
    });

    // Parallel groups run exactly one iteration
    this.events?.onGroupIteration?.({
      group_name: group.group,
      iteration: 1,
      max_iterations: group.max_iterations,
    });
    this.emitter.emit({
      type: 'group_iteration',
      groupName: group.group,
      iteration: 1,
      maxIterations: group.max_iterations,
    });

    if (signal?.aborted) {
      this.events?.onGroupComplete?.({ group_name: group.group, iterations: 1, status: 'cancelled' });
      this.emitter.emit({ type: 'group_complete', groupName: group.group, iterations: 1, status: 'cancelled' });
      return { status: 'cancelled', stageRuns: [], stagesExecuted: group.stages.length, context };
    }

    // All parallel stages read the same pre-group context snapshot.
    // previousStageName = the last stage before this group.
    let previousStageName: string | undefined;
    for (const [name] of context.stageOutputs) {
      previousStageName = name;
    }

    // fail-fast: create a shared AbortController to cancel siblings on first failure
    const groupAbort = (group.on_failure ?? 'fail-fast') === 'fail-fast'
      ? new AbortController()
      : null;
    if (groupAbort && signal) {
      signal.addEventListener('abort', () => groupAbort.abort(), { once: true });
    }
    const stageSignal = groupAbort?.signal ?? signal;

    // Launch all stages concurrently
    const settled = await Promise.allSettled(
      group.stages.map(async (stage, i) => {
        const result = await this.executeStage(
          stage,
          context,
          previousStageName,
          userInput,
          stageOffset + i,
          totalStages,
          paths,
          toolRegistry,
          runMiddleware,
          runId,
          stageSignal,
        );
        // fail-fast: abort remaining stages on first non-success
        if (groupAbort && result.status !== 'success') {
          groupAbort.abort();
        }
        return { stageName: stage.name, result };
      }),
    );

    // Build result map keyed by stage name
    const resultMap = new Map<string, StageResult>();
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        resultMap.set(s.value.stageName, s.value.result);
      }
    }

    // Collect stage runs in definition order (deterministic output ordering)
    const allStageRuns: StageRun[] = [];
    for (const stage of group.stages) {
      const result = resultMap.get(stage.name);
      if (result) allStageRuns.push(result.stageRun);
    }

    // Derive group status: cancelled > failed > success
    // rejected treated as failed in parallel mode (no feedback loop)
    let groupStatus: StageStatus = 'success';
    for (const stage of group.stages) {
      const result = resultMap.get(stage.name);
      if (!result) { groupStatus = 'failed'; continue; }
      if (result.status === 'cancelled' && groupStatus === 'success') groupStatus = 'cancelled';
      if (result.status === 'failed' || result.status === 'rejected') groupStatus = 'failed';
    }

    // Merge successful outputs into context in definition order (regardless of group status)
    // This preserves observability for collect-all partial failures
    for (const stage of group.stages) {
      const result = resultMap.get(stage.name);
      if (!result || result.status !== 'success') continue;
      if (result.lastAgentOutput !== undefined) {
        addStageOutput(context, stage.name, result.lastAgentOutput);
      }
      if (result.toolCalls?.length) {
        addStageToolResults(context, stage.name, result.toolCalls);
      }
    }

    this.events?.onGroupComplete?.({ group_name: group.group, iterations: 1, status: groupStatus });
    this.emitter.emit({ type: 'group_complete', groupName: group.group, iterations: 1, status: groupStatus });

    return {
      status: groupStatus,
      stageRuns: allStageRuns,
      stagesExecuted: group.stages.length,
      context,
    };
  }

  private async runGroupSequential(
    group: StageGroup,
    context: PipelineContext,
    stageOffset: number,
    totalStages: number,
    userInput: string | Record<string, unknown>,
    paths: ProjectPaths,
    toolRegistry: ToolRegistry | undefined,
    runMiddleware?: AnonymizationMiddleware | null,
    runId?: string,
    signal?: AbortSignal,
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
      // Check cancellation before group iteration
      if (signal?.aborted) {
        this.events?.onGroupComplete?.({
          group_name: group.group,
          iterations: iteration,
          status: 'cancelled',
        });
        this.emitter.emit({
          type: 'group_complete',
          groupName: group.group,
          iterations: iteration,
          status: 'cancelled',
        });
        return {
          status: 'cancelled',
          stageRuns: allStageRuns,
          stagesExecuted: group.stages.length,
          context,
        };
      }

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
        if (signal?.aborted) break;

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
          toolRegistry,
          runMiddleware,
          runId,
          signal,
        );

        allStageRuns.push(result.stageRun);

        // Cancelled → stop group
        if (result.status === 'cancelled') {
          this.events?.onGroupComplete?.({
            group_name: group.group,
            iterations: iteration,
            status: 'cancelled',
          });
          this.emitter.emit({
            type: 'group_complete',
            groupName: group.group,
            iterations: iteration,
            status: 'cancelled',
          });
          return {
            status: 'cancelled',
            stageRuns: allStageRuns,
            stagesExecuted: group.stages.length,
            context,
          };
        }

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
        if (result.toolCalls && result.toolCalls.length > 0) {
          addStageToolResults(context, stage.name, result.toolCalls);
        }
        previousStageName = stage.name;

        // Last stage rejected → feedback loop
        const isLastStage = i === group.stages.length - 1;
        if (result.status === 'rejected' && isLastStage) {
          groupSucceeded = false;

          if (iteration < group.max_iterations) {
            // Clear group stage outputs and tool results for next iteration
            for (const gs of group.stages) {
              context.stageOutputs.delete(gs.name);
              context.stageToolResults.delete(gs.name);
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
      const { join } = await import('node:path');
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
