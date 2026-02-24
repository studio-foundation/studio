// Run launcher — interface + InProcessLauncher implementation
// InProcessLauncher fires pipelines as background Promises.
// Future: BullMQLauncher, etc.

import { randomUUID } from 'node:crypto';
import type { PipelineEngine, RunStore } from '@studio/engine';
import { createApiLogger } from './logger.js';

export interface LaunchConfig {
  runId: string;
  pipeline: string;
  input: Record<string, unknown>;
  configsDir: string;
  providerOverride?: string;
}

export interface RunLauncher {
  launch(config: LaunchConfig): Promise<{ run_id: string }>;
  cancel(run_id: string): Promise<void>;
}

export class InProcessLauncher implements RunLauncher {
  private active = new Map<string, AbortController>();

  constructor(
    private engine: PipelineEngine,
    private store: RunStore,
    private runsDir: string,
  ) {}

  async launch(config: LaunchConfig): Promise<{ run_id: string }> {
    const { runId, pipeline, input } = config;
    const controller = new AbortController();
    this.active.set(runId, controller);

    // Create JSONL logger and save path immediately
    const logger = createApiLogger(this.runsDir, runId, pipeline);
    this.store.saveLogPath(runId, logger.logPath);

    // Fire-and-forget
    void this.engine
      .run({
        id: runId,
        pipeline,
        input,
        signal: controller.signal,
      })
      .then(async (run) => {
        logger.log({ event: 'pipeline_complete', status: run.status });
        await logger.close();
      })
      .catch(async (err: unknown) => {
        logger.log({ event: 'pipeline_error', error: String(err) });
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

export function generateRunId(): string {
  return randomUUID();
}
