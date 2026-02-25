import type { RunSpawner, SpawnConfig, SpawnResult, PipelineRun } from '@studio/contracts';
import { PipelineEngine, type EngineConfig } from '../engine.js';

export class DirectEngineSpawner implements RunSpawner {
  constructor(private engineConfig: EngineConfig) {}

  async spawnAndWait(config: SpawnConfig): Promise<SpawnResult> {
    const child = new PipelineEngine(this.engineConfig);
    const result: PipelineRun = await child.run({
      pipeline: config.pipeline,
      input: config.input,
      parentRunId: config.parentRunId,
      depth: config.depth,
    });

    if (result.status === 'failed' || result.status === 'rejected') {
      throw new Error(`Child run ${result.id} ${result.status}`);
    }

    // Extract output from the last successful stage
    const lastStage = [...result.stages].reverse().find(s => s.status === 'success');
    const output = (lastStage as { output?: unknown } | undefined)?.output ?? null;

    return { run_id: result.id, status: result.status, output };
  }
}
