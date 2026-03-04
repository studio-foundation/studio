// Main pipeline engine — the orchestrator
// Connects ralph (retry loop) + runner (agent execution) + contracts (validation)

import { randomUUID } from 'node:crypto';
import type {
  PipelineEntry,
  PipelineRun,
  PipelineDefinition,
  RunSpawner,
} from '@studio/contracts';
import { isStageGroup } from '@studio/contracts';
import {
  type ToolRegistry,
  type ProviderRegistry,
  AnonymizationMiddleware,
  createStudioRunTool,
  STUDIO_RUN_PROMPT_SNIPPET,
} from '@studio/runner';
import { loadPipelineByName } from './pipeline/loader.js';
import { executeStartupCommands } from './pipeline/startup-executor.js';
import { loadInvariantsFile } from './pipeline/invariants-loader.js';
import {
  createInitialContext,
  addStageOutput,
  addStageToolResults,
  clearGroupFeedback,
} from './pipeline/context-propagation.js';
import type { AnyRunStore } from './state/run-store.js';
import type { EngineEvents } from './events.js';
import { PipelineEventEmitter } from './events.js';
import { resolveProjectPaths } from './pipeline/types.js';
import { StageExecutor } from './pipeline/stage-executor.js';
import { GroupOrchestrator } from './pipeline/group-orchestrator.js';

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
  private stageExecutor: StageExecutor;
  private groupOrchestrator: GroupOrchestrator;

  constructor(
    private config: EngineConfig,
    private events?: EngineEvents,
  ) {
    this.emitter = new PipelineEventEmitter();
    this.stageExecutor = new StageExecutor({
      events,
      emitter: this.emitter,
      providerRegistry: config.providerRegistry,
      repoPath: config.repoPath,
      configsDir: config.configsDir,
      pluginSkills: config.pluginSkills,
      providerOverride: config.providerOverride,
    });
    this.groupOrchestrator = new GroupOrchestrator({
      events,
      emitter: this.emitter,
      stageExecutor: this.stageExecutor,
    });
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
        await this.config.db?.savePipelineRun(pipelineRun);
        this.events?.onPipelineComplete?.({
          pipeline_name: pipeline.name,
          run_id: pipelineRun.id,
          status: 'cancelled',
          duration_ms: Date.now() - pipelineStartTime,
          total_tokens: this.pipelineTotals.tokens,
          total_tool_calls: this.pipelineTotals.toolCalls,
        });
        this.emitter.emit({ type: 'pipeline_complete', pipelineId: pipelineRun.id });
        return pipelineRun;
      }

      if (isStageGroup(entry)) {
        // ========== GROUP ==========
        const groupResult = await this.groupOrchestrator.run(
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
        this.pipelineTotals.tokens += groupResult.totalTokensDelta;
        this.pipelineTotals.toolCalls += groupResult.totalToolCallsDelta;

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
          await this.config.db?.savePipelineRun(pipelineRun);
          if (runMiddleware) {
            await this.persistKeymap(pipelineRun.id, runMiddleware.getKeymap());
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
          return pipelineRun;
        }
      } else {
        // ========== SIMPLE STAGE ==========
        stageCounter++;
        const result = await this.stageExecutor.execute(
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
        this.pipelineTotals.tokens += result.tokensDelta ?? 0;
        this.pipelineTotals.toolCalls += result.toolCallsDelta ?? 0;

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
          await this.config.db?.savePipelineRun(pipelineRun);
          if (runMiddleware) {
            await this.persistKeymap(pipelineRun.id, runMiddleware.getKeymap());
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

    // 6. Persist then emit (DB must be updated before SSE fires, so spawnAndWait GET sees final status)
    await this.config.db?.savePipelineRun(pipelineRun);
    if (runMiddleware) {
      await this.persistKeymap(pipelineRun.id, runMiddleware.getKeymap());
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

    return pipelineRun;
  }

  /** For external listeners via the generic event bus */
  onEvent(listener: (event: import('./events.js').PipelineEvent) => void): void {
    this.emitter.on(listener);
  }

  // -- Private --

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
