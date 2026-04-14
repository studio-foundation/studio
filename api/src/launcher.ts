// Run launcher — interface + InProcessLauncher implementation
// InProcessLauncher creates a new PipelineEngine per run for event isolation.
// Future: BullMQLauncher, etc.

import type { PipelineRun } from '@studio-foundation/contracts';
import type {
  EngineConfig,
  EngineEvents,
  AnyRunStore,
  PipelineStartEvent,
  StageStartEvent,
  StageCompleteEvent,
  StageRetryEvent,
  StageContextEvent,
  GroupStartEvent,
  GroupIterationEvent,
  GroupFeedbackEvent,
  GroupCompleteEvent,
  PipelineCompleteEvent,
  PipelineCancelledEvent,
  StagedToolCallStartEvent,
  StagedToolCallCompleteEvent,
} from '@studio-foundation/engine';
import { PipelineEngine } from '@studio-foundation/engine';
import { loadProjectTools } from '@studio-foundation/runner';
import { join } from 'node:path';
import { createApiLogger } from './logger.js';
import type { RunEventBus, BusListener, SseEventType } from './event-bus.js';
import type { AnyUserStore } from './user-store-pg.js';
import { getPlanLimits, DEFAULT_PLANS, type PlansConfig } from './plans.js';

export interface LaunchConfig {
  runId: string;
  pipeline: string;
  input: Record<string, unknown>;
  configsDir: string;
  /** Pre-resolved repo path (cloned or local). Overrides engineConfig.repoPath for this run. */
  repoPath?: string;
  providerOverride?: string;
  depth?: number;
  parentRunId?: string;
  meta?: Record<string, unknown>;
  userId?: string;
}

export type EngineFactory = (
  config: EngineConfig,
  events: EngineEvents,
) => Pick<PipelineEngine, 'run'>;

export interface RunLauncher {
  launch(config: LaunchConfig): Promise<{ run_id: string }>;
  cancel(run_id: string): Promise<void>;
  subscribe(runId: string, listener: BusListener): () => void;
}

export class InProcessLauncher implements RunLauncher {
  private active = new Map<string, AbortController>();
  private activePerUser = new Map<string, Set<string>>(); // userId → Set<runId>

  constructor(
    private engineConfig: EngineConfig,
    private store: AnyRunStore,
    private runsDir: string,
    private bus: RunEventBus,
    private engineFactory: EngineFactory = (cfg, evts) => new PipelineEngine(cfg, evts),
    private userStore?: AnyUserStore,
    private plans: PlansConfig = DEFAULT_PLANS,
  ) {}

  subscribe(runId: string, listener: BusListener): () => void {
    return this.bus.subscribe(runId, listener);
  }

  async launch(config: LaunchConfig): Promise<{ run_id: string }> {
    const { runId, pipeline, input, meta, parentRunId, userId } = config;

    // Quota enforcement (only if userId provided and userStore available)
    if (userId && this.userStore) {
      const user = await this.userStore.getUserById(userId);
      if (user) {
        const today = new Date().toISOString().slice(0, 10);
        const limits = getPlanLimits(this.plans, user.plan);

        // Check runs_per_day
        if (limits.runs_per_day !== -1) {
          const usage = await this.userStore.getDailyUsage(userId, today);
          if (usage.runs_count >= limits.runs_per_day) {
            throw Object.assign(
              new Error('Daily run limit exceeded'),
              { code: 'QUOTA_EXCEEDED', limit: limits.runs_per_day, used: usage.runs_count }
            );
          }
        }

        // Check max_concurrent
        const activeForUser = this.activePerUser.get(userId)?.size ?? 0;
        if (activeForUser >= limits.max_concurrent) {
          throw Object.assign(
            new Error('Concurrent run limit exceeded'),
            { code: 'QUOTA_EXCEEDED', limit: limits.max_concurrent, used: activeForUser }
          );
        }

        // Increment runs_count
        await this.userStore.incrementRuns(userId, today);
      }
    }

    // Track active run for user (before creating the controller)
    if (userId) {
      if (!this.activePerUser.has(userId)) this.activePerUser.set(userId, new Set());
      this.activePerUser.get(userId)!.add(runId);
    }

    const controller = new AbortController();
    this.active.set(runId, controller);

    const logger = createApiLogger(this.runsDir, runId, pipeline);

    // Pre-create the run in the store so GET /api/runs/:id/stream can find it immediately
    // after launch() returns. The engine will upsert it again at onPipelineStart with the
    // same id (savePipelineRun is ON CONFLICT DO UPDATE in all store implementations).
    const stubRun: PipelineRun = {
      id: runId,
      pipeline_name: pipeline,
      status: 'running',
      started_at: new Date().toISOString(),
      stages: [],
      ...(input && typeof input === 'object' ? { input: input as Record<string, unknown> } : {}),
      ...(parentRunId ? { parent_run_id: parentRunId } : {}),
    };
    await this.store.savePipelineRun(stubRun);

    // Save log path immediately so callers can locate the log file right after launch().
    // For InMemoryRunStore this is a simple Map.set() and works regardless of row existence.
    // For SQLiteRunStore/PgRunStore the row now exists, so the UPDATE will take effect.
    void this.store.saveLogPath(runId, logger.logPath);

    const emit = (type: SseEventType, data: object) => {
      this.bus.emit(runId, type, data);
      logger.log({ event: type, ...(data as Record<string, unknown>) });
    };

    // Track last group feedback for inclusion in the pipeline_complete bus event
    let lastGroupFeedback: GroupFeedbackEvent | undefined;

    const perRunEvents: EngineEvents = {
      onPipelineStart: (e: PipelineStartEvent) => {
        // Row exists now — persist log_path for SQLiteRunStore (the call in launch() was a no-op there).
        void this.store.saveLogPath(runId, logger.logPath);
        emit('pipeline_start', e);
      },
      onStageStart:        (e: StageStartEvent) =>        emit('stage_start', e),
      onStageComplete:     (e: StageCompleteEvent) =>     emit('stage_complete', e),
      onTaskRetry:         (e: StageRetryEvent) =>        emit('stage_retry', e),
      onGroupStart:        (e: GroupStartEvent) =>        emit('group_start', e),
      onGroupIteration:    (e: GroupIterationEvent) =>    emit('group_iteration', e),
      onGroupFeedback:     (e: GroupFeedbackEvent) => {
        lastGroupFeedback = e;
        emit('group_feedback', e);
      },
      onGroupComplete:     (e: GroupCompleteEvent) =>          emit('group_complete', e),
      onStageContext:      (e: StageContextEvent) =>           emit('stage_context', e),
      onToolCallStart:     (e: StagedToolCallStartEvent) =>    emit('tool_call_start', e),
      onToolCallComplete:  (e: StagedToolCallCompleteEvent) => emit('tool_call_complete', e),
      onPipelineComplete:  (e: PipelineCompleteEvent) => {
        emit('pipeline_complete', { ...e, meta: meta ?? {}, last_group_feedback: lastGroupFeedback });
        this.bus.close(runId);
      },
      onPipelineCancelled: (e: PipelineCancelledEvent) => {
        emit('pipeline_cancelled', e);
      },
    };

    let runEngineConfig: EngineConfig = this.engineConfig;
    if (config.repoPath !== undefined) {
      const toolsDir = join(this.engineConfig.configsDir, 'tools');
      const freshPlugins = await loadProjectTools(toolsDir, config.repoPath);
      // toolRegistry is always provided when using the API launcher
      const freshRegistry = this.engineConfig.toolRegistry!.clone();
      for (const plugin of freshPlugins) {
        freshRegistry.registerPlugin(plugin.name, plugin.tools, plugin.promptSnippet);
      }
      runEngineConfig = { ...this.engineConfig, repoPath: config.repoPath, toolRegistry: freshRegistry };
    }
    const engine = this.engineFactory(runEngineConfig, perRunEvents);

    void engine
      .run({ pipeline, input, meta, signal: controller.signal, id: runId, depth: config.depth, parentRunId })
      .then(async () => {
        await logger.close();
      })
      .catch(async (err: unknown) => {
        logger.log({ event: 'pipeline_error', error: String(err) });
        this.bus.close(runId);
        await logger.close();
      })
      .finally(() => {
        this.active.delete(runId);
        if (userId) {
          this.activePerUser.get(userId)?.delete(runId);
        }
      });

    return { run_id: runId };
  }

  async cancel(run_id: string): Promise<void> {
    this.active.get(run_id)?.abort();
  }
}

export { randomUUID as generateRunId } from 'node:crypto';
