import type { RunSpawner, SpawnConfig, SpawnResult, PipelineRun } from '@studio-foundation/contracts';
import { PipelineEngine, type EngineConfig } from '../engine.js';

export class DirectEngineSpawner implements RunSpawner {
  constructor(private engineConfig: EngineConfig) {}

  async spawnAndWait(config: SpawnConfig): Promise<SpawnResult> {
    // Hand the spawner down: without it a child engine cannot run `call`/`map`
    // stages of its own, capping nesting at depth 1 while maxDepth promises 3
    // (STU-615). The orchestrators' depth guard is the recursion limit.
    const child = new PipelineEngine({ ...this.engineConfig, spawner: this });
    const result: PipelineRun = await child.run({
      pipeline: config.pipeline,
      input: config.input,
      parentRunId: config.parentRunId,
      depth: config.depth,
    });

    if (result.status === 'failed' || result.status === 'rejected' || result.status === 'cancelled') {
      throw new Error(`Child run ${result.id} ${result.status}`);
    }

    // Extract output from the last successful stage
    const lastStage = [...result.stages].reverse().find(s => s.status === 'success');
    const output = (lastStage as { output?: unknown } | undefined)?.output ?? null;

    return { run_id: result.id, status: result.status, output };
  }
}
