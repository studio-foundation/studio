import type { RunSpawner, SpawnConfig, SpawnResult, PipelineRun } from '@studio-foundation/contracts';
import { PipelineEngine, type EngineConfig } from '../engine.js';
import { createTaggingAdapter, type EngineEvents } from '../events.js';

export class DirectEngineSpawner implements RunSpawner {
  private childCounter = 0;

  constructor(private engineConfig: EngineConfig, private events?: EngineEvents) {}

  async spawnAndWait(config: SpawnConfig): Promise<SpawnResult> {
    // Hand the spawner down: without it a child engine cannot run `call`/`map`
    // stages of its own, capping nesting at depth 1 while maxDepth promises 3
    // (STU-615). The orchestrators' depth guard is the recursion limit.
    //
    // Stamp the child's events with its depth + a unique childId so event
    // consumers can distinguish concurrent child runs (STU-620). The CLI
    // currently renders nesting by depth alone.
    const childEvents = this.events
      ? createTaggingAdapter(this.events, { depth: config.depth, childId: `d${config.depth}#${this.childCounter++}` })
      : undefined;
    const child = new PipelineEngine({ ...this.engineConfig, spawner: this }, childEvents);
    const result: PipelineRun = await child.run({
      pipeline: config.pipeline,
      input: config.input,
      parentRunId: config.parentRunId,
      depth: config.depth,
    });

    if (result.status === 'failed' || result.status === 'rejected' || result.status === 'cancelled') {
      throw new Error(`Child run ${result.id} ${result.status}`);
    }

    const lastStage = [...result.stages].reverse().find(s => s.status === 'success');
    const output = (lastStage as { output?: unknown } | undefined)?.output ?? null;

    return { run_id: result.id, status: result.status, output };
  }
}
