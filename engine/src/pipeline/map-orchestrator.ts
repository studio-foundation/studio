// MapOrchestrator — executes a fan-out (map) stage.
//
// A map stage runs a sub-pipeline once per item of a list and collects the
// structured outputs. It replaces the "shell `studio run <pipeline>` per item
// + parse stdout + scrape the run log" glue: child runs are spawned in-process
// through the engine's RunSpawner and each returns its last-stage output
// directly — no scraping, no tempfiles.
//
// Concurrency is bounded by `concurrency` (default 1 = sequential). The
// per-item failure policy is `on_item_failure`:
//   - fail-fast (default): stop launching new items on the first failure; the
//     stage fails. In-flight items are allowed to finish.
//   - collect-all: run every item regardless; the stage succeeds as long as at
//     least one item succeeded (or the list was empty). Per-item failures are
//     surfaced in the output, never fatal — the pipeline keeps going.

import { randomUUID } from 'node:crypto';
import type { MapStage, RunSpawner, StageRun, StageStatus, TaskRun } from '@studio-foundation/contracts';
import type { EngineEvents, PipelineEventEmitter } from '../events.js';
import { resolveContextPath, evaluateCondition } from './condition-evaluator.js';
import { buildItemInput } from './map-input.js';
import type { PipelineContext } from './context-propagation.js';

export interface MapItemResult {
  index: number;
  status: 'success' | 'failed';
  output?: unknown;
  error?: string;
  run_id?: string;
}

export interface MapStageOutput {
  total: number;
  succeeded: number;
  failed: number;
  results: MapItemResult[];
  /** Successful item outputs in index order — the common "collect what worked" path. */
  outputs: unknown[];
}

export interface MapRunResult {
  status: StageStatus;
  stageRun: StageRun;
  output?: MapStageOutput;
}

export interface MapOrchestratorConfig {
  events?: EngineEvents;
  emitter: PipelineEventEmitter;
  spawner?: RunSpawner;
  maxDepth: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class MapOrchestrator {
  constructor(private config: MapOrchestratorConfig) {}

  async run(
    map: MapStage,
    context: PipelineContext,
    stageIndex: number,
    totalStages: number,
    runId: string,
    depth: number,
    signal?: AbortSignal,
  ): Promise<MapRunResult> {
    const startedAt = new Date().toISOString();
    const stageRun: StageRun = {
      id: randomUUID(),
      stage_name: map.map,
      status: 'running',
      started_at: startedAt,
      tasks: [],
    };

    const finish = (status: StageStatus, output?: MapStageOutput, skippedReason?: string): MapRunResult => {
      stageRun.status = status;
      stageRun.completed_at = new Date().toISOString();
      if (output !== undefined) stageRun.output = output;
      if (skippedReason) stageRun.skipped_reason = skippedReason;
      this.config.events?.onStageComplete?.({
        stage_name: map.map,
        stage_index: stageIndex,
        total_stages: totalStages,
        status,
        attempts: 1,
        duration_ms: Date.now() - new Date(startedAt).getTime(),
        ...(output ? { output } : {}),
        ...(skippedReason ? { skipped_reason: skippedReason } : {}),
      });
      this.config.emitter.emit({ type: 'stage_complete', stageId: stageRun.id, stageName: map.map });
      return { status, stageRun, output };
    };

    // Technical failure (bad `over`, missing spawner, depth limit) — record the
    // reason on the stage as a failed task so it surfaces in `studio status`,
    // the run JSONL, and the CLI's "Errors:" line, then fail the stage.
    const failTechnical = (reason: string): MapRunResult => {
      const now = new Date().toISOString();
      const taskRun: TaskRun = {
        id: randomUUID(),
        task_name: map.map,
        status: 'failed',
        started_at: startedAt,
        completed_at: now,
        agent_runs: [{
          id: randomUUID(),
          agent_name: `map:${map.pipeline}`,
          attempt: 1,
          status: 'failed',
          tool_calls: 0,
          started_at: startedAt,
          completed_at: now,
          error: reason,
        }],
      };
      stageRun.tasks = [taskRun];
      return finish('failed');
    };

    this.config.events?.onStageStart?.({
      stage_name: map.map,
      stage_index: stageIndex,
      total_stages: totalStages,
      max_attempts: 1,
    });
    this.config.emitter.emit({ type: 'stage_start', stageId: stageRun.id, stageName: map.map });

    // Condition — skip the whole fan-out if false
    if (map.condition !== undefined) {
      const shouldRun = evaluateCondition(map.condition, {
        input: context.input,
        stageOutputs: context.stageOutputs,
      });
      if (!shouldRun) {
        return finish('skipped', undefined, `condition not met: ${map.condition}`);
      }
    }

    if (signal?.aborted) return finish('cancelled');

    // A map stage spawns child runs — it needs a spawner.
    if (!this.config.spawner) {
      return failTechnical(
        `Map stage '${map.map}' requires a run spawner, but none is configured. ` +
        `Fan-out stages spawn sub-pipeline runs; construct the engine with a 'spawner'.`
      );
    }
    const spawner = this.config.spawner;

    // Resolve the list to iterate.
    const resolved = resolveContextPath(map.over, {
      input: context.input,
      stageOutputs: context.stageOutputs,
    });
    if (!Array.isArray(resolved)) {
      return failTechnical(
        `Map stage '${map.map}': 'over: ${map.over}' did not resolve to an array ` +
        `(got ${resolved === undefined ? 'undefined' : typeof resolved}). ` +
        `It must reference a list, e.g. stages.<name>.output.items or input.items.`
      );
    }
    const items = resolved;

    const concurrency = Math.max(1, map.concurrency ?? 1);
    const failFast = (map.on_item_failure ?? 'fail-fast') === 'fail-fast';

    this.config.events?.onMapStart?.({ map_name: map.map, total_items: items.length, concurrency });
    this.config.emitter.emit({ type: 'map_start', mapName: map.map, totalItems: items.length });

    if (items.length === 0) {
      const emptyOutput: MapStageOutput = { total: 0, succeeded: 0, failed: 0, results: [], outputs: [] };
      this.config.events?.onMapComplete?.({ map_name: map.map, total: 0, succeeded: 0, failed: 0, status: 'success' });
      this.config.emitter.emit({ type: 'map_complete', mapName: map.map, succeeded: 0, failed: 0, status: 'success' });
      return finish('success', emptyOutput);
    }

    // Depth guard — mirror studio_run's recursion limit.
    if (depth + 1 > this.config.maxDepth) {
      return failTechnical(
        `Map stage '${map.map}' would spawn runs at depth ${depth + 1}, exceeding maxDepth ${this.config.maxDepth}. ` +
        `Recursive fan-out is not allowed at this nesting level.`
      );
    }

    const results = new Array<MapItemResult | undefined>(items.length);
    let cursor = 0;
    let abortLaunch = false; // fail-fast: stop pulling new items after a failure

    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal?.aborted || abortLaunch) return;
        const i = cursor++;
        if (i >= items.length) return;

        let itemResult: MapItemResult;
        try {
          const input = buildItemInput(map, items[i], i, context.input);
          const spawn = await spawner.spawnAndWait({
            pipeline: map.pipeline,
            input,
            parentRunId: runId,
            depth: depth + 1,
          });
          itemResult = { index: i, status: 'success', output: spawn.output, run_id: spawn.run_id };
        } catch (err) {
          itemResult = { index: i, status: 'failed', error: errorMessage(err) };
          if (failFast) abortLaunch = true;
        }

        results[i] = itemResult;
        this.config.events?.onMapItemComplete?.({
          map_name: map.map,
          index: i,
          total_items: items.length,
          status: itemResult.status,
          ...(itemResult.run_id ? { run_id: itemResult.run_id } : {}),
          ...(itemResult.error ? { error: itemResult.error } : {}),
        });
        this.config.emitter.emit({ type: 'map_item_complete', mapName: map.map, index: i, status: itemResult.status });
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
    );

    // Cancelled mid-flight → cancelled (don't report success/failure of a partial batch).
    if (signal?.aborted) return finish('cancelled');

    const settled = results.filter((r): r is MapItemResult => r !== undefined);
    settled.sort((a, b) => a.index - b.index);
    const succeeded = settled.filter(r => r.status === 'success');
    const failed = settled.filter(r => r.status === 'failed');

    const output: MapStageOutput = {
      total: items.length,
      succeeded: succeeded.length,
      failed: failed.length,
      results: settled,
      outputs: succeeded.map(r => r.output),
    };

    // Status policy:
    //   fail-fast   → any failure fails the stage.
    //   collect-all → succeeds as long as at least one item succeeded; a batch
    //                 where every item failed is a real failure, not per-item noise.
    let status: StageStatus;
    if (failFast) {
      status = failed.length > 0 ? 'failed' : 'success';
    } else {
      status = succeeded.length > 0 ? 'success' : 'failed';
    }

    this.config.events?.onMapComplete?.({
      map_name: map.map,
      total: items.length,
      succeeded: succeeded.length,
      failed: failed.length,
      status,
    });
    this.config.emitter.emit({
      type: 'map_complete',
      mapName: map.map,
      succeeded: succeeded.length,
      failed: failed.length,
      status,
    });

    return finish(status, output);
  }
}
