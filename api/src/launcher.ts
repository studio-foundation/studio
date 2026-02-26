// Run launcher — interface + InProcessLauncher implementation
// InProcessLauncher creates a new PipelineEngine per run for event isolation.
// Future: BullMQLauncher, etc.

import type {
  EngineConfig,
  EngineEvents,
  RunStore,
  PipelineStartEvent,
  StageStartEvent,
  StageCompleteEvent,
  StageRetryEvent,
  GroupStartEvent,
  GroupIterationEvent,
  GroupFeedbackEvent,
  GroupCompleteEvent,
  PipelineCompleteEvent,
  PipelineCancelledEvent,
} from '@studio/engine';
import { PipelineEngine } from '@studio/engine';
import { createApiLogger } from './logger.js';
import type { RunEventBus, BusListener, SseEventType } from './event-bus.js';

export interface LaunchConfig {
  runId: string;
  pipeline: string;
  input: Record<string, unknown>;
  configsDir: string;
  providerOverride?: string;
  depth?: number;
  parentRunId?: string;
  meta?: Record<string, unknown>;
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

  constructor(
    private engineConfig: EngineConfig,
    private store: RunStore,
    private runsDir: string,
    private bus: RunEventBus,
    private engineFactory: EngineFactory = (cfg, evts) => new PipelineEngine(cfg, evts),
  ) {}

  subscribe(runId: string, listener: BusListener): () => void {
    return this.bus.subscribe(runId, listener);
  }

  async launch(config: LaunchConfig): Promise<{ run_id: string }> {
    const { runId, pipeline, input, meta } = config;
    const controller = new AbortController();
    this.active.set(runId, controller);

    const logger = createApiLogger(this.runsDir, runId, pipeline);

    const emit = (type: SseEventType, data: object) => {
      this.bus.emit(runId, type, data);
      logger.log({ event: type, ...(data as Record<string, unknown>) });
    };

    const perRunEvents: EngineEvents = {
      onPipelineStart: (e: PipelineStartEvent) => {
        // Row exists now (engine saves it before firing this event) — safe to write log_path
        this.store.saveLogPath(runId, logger.logPath);
        emit('pipeline_start', e);
      },
      onStageStart:        (e: StageStartEvent) =>        emit('stage_start', e),
      onStageComplete:     (e: StageCompleteEvent) =>     emit('stage_complete', e),
      onTaskRetry:         (e: StageRetryEvent) =>        emit('stage_retry', e),
      onGroupStart:        (e: GroupStartEvent) =>        emit('group_start', e),
      onGroupIteration:    (e: GroupIterationEvent) =>    emit('group_iteration', e),
      onGroupFeedback:     (e: GroupFeedbackEvent) =>     emit('group_feedback', e),
      onGroupComplete:     (e: GroupCompleteEvent) =>     emit('group_complete', e),
      onPipelineComplete:  (e: PipelineCompleteEvent) => {
        emit('pipeline_complete', e);
        this.bus.close(runId);
      },
      onPipelineCancelled: (e: PipelineCancelledEvent) => {
        emit('pipeline_cancelled', e);
        this.bus.close(runId);
      },
    };

    const engine = this.engineFactory(this.engineConfig, perRunEvents);

    void engine
      .run({ pipeline, input, meta, signal: controller.signal, id: runId, depth: config.depth, parentRunId: config.parentRunId })
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
      });

    return { run_id: runId };
  }

  async cancel(run_id: string): Promise<void> {
    this.active.get(run_id)?.abort();
  }
}

export { randomUUID as generateRunId } from 'node:crypto';
