import type { ChildStageUsage, RunSpawner, SpawnConfig, SpawnResult, PipelineRun, StageRun } from '@studio-foundation/contracts';
import { ChildRunError, sumTokenUsage } from '@studio-foundation/contracts';
import type { ProviderRegistry } from '@studio-foundation/runner';
import { PipelineEngine, type EngineConfig } from '../engine.js';
import { createTaggingAdapter, type EngineEvents } from '../events.js';

/**
 * The child's stages as the parent needs them: what ran, how it ended, how many
 * attempts it took, and what those attempts spent. Attempts come from the agent
 * runs the stage recorded — one per RALPH attempt — so a stage that retried
 * twice reports 3, not 1.
 */
function childStageUsage(stages: StageRun[]): ChildStageUsage[] {
  return stages.map(stage => ({
    stage: stage.stage_name,
    status: stage.status,
    attempts: stage.tasks.reduce(
      (max, task) => task.agent_runs.reduce((n, run) => Math.max(n, run.attempt), max),
      0,
    ),
    ...(stage.token_usage ? { token_usage: stage.token_usage } : {}),
  }));
}

export class DirectEngineSpawner implements RunSpawner {
  private childCounter = 0;

  constructor(private engineConfig: EngineConfig, private events?: EngineEvents) {}

  async spawnAndWait(config: SpawnConfig): Promise<SpawnResult> {
    // Per-spawn overrides — today only a substituted provider registry, set by a
    // `batch:` map stage so this child's LLM calls park in the parent's batch
    // window. The cast is the price of contracts staying a leaf (INV-04): the
    // registry type lives in runner, so SpawnOverrides can only name it as
    // `unknown`. A remote spawner ignores overrides entirely — a batch window is
    // a this-process object.
    //
    // The override rides on the child's own spawner too, so a nested `call`/`map`
    // inside the item batches with it rather than silently dropping back to
    // full-price single calls.
    const overrideRegistry = config.overrides?.providerRegistry as ProviderRegistry | undefined;
    const engineConfig: EngineConfig = overrideRegistry
      ? { ...this.engineConfig, providerRegistry: overrideRegistry }
      : this.engineConfig;
    const spawner: RunSpawner = overrideRegistry
      ? new DirectEngineSpawner(engineConfig, this.events)
      : this;

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
    const child = new PipelineEngine({ ...engineConfig, spawner }, childEvents);
    const result: PipelineRun = await child.run({
      pipeline: config.pipeline,
      input: config.input,
      parentRunId: config.parentRunId,
      depth: config.depth,
    });

    // Built before the failure branch: a child that died still made billed calls,
    // and dropping them is what makes a failed fan-out item price as one call.
    const stages = childStageUsage(result.stages);
    const token_usage = sumTokenUsage(result.stages.map(s => s.token_usage));

    if (result.status === 'failed' || result.status === 'rejected' || result.status === 'cancelled') {
      const lastFailedStage = [...result.stages].reverse().find(
        s => s.status === 'failed' || s.status === 'rejected' || s.status === 'cancelled'
      );
      const stageError = lastFailedStage?.tasks
        .flatMap(t => t.agent_runs)
        .reverse()
        .find(a => a.error)?.error;
      throw new ChildRunError(
        `Child run ${result.id} ${result.status}: ${stageError ?? 'no error recorded'}`,
        result.id,
        result.status,
        stages,
        token_usage,
      );
    }

    const lastStage = [...result.stages].reverse().find(s => s.status === 'success');
    const output = (lastStage as { output?: unknown } | undefined)?.output ?? null;

    return { run_id: result.id, status: result.status, output, stages, ...(token_usage ? { token_usage } : {}) };
  }
}
