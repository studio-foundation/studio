// CallOrchestrator — executes a one-shot `call` stage.
//
// A call stage runs a named pipeline once and exposes its output to later parent
// stages under the stage name. It is `map` with the iteration removed: the same
// in-process RunSpawner path (structured output, no log scraping), for when the
// shape is a sequence rather than a fan-out — chaining top-level pipelines like
// wiki-extraction → wiki-resolution → wiki-preparation → pages-export in one
// YAML, which `run_wiki.py` otherwise sequences outside Studio.

import { randomUUID } from 'node:crypto';
import type { CallStage, RunSpawner, StageRun, StageStatus, TaskRun } from '@studio-foundation/contracts';
import type { EngineEvents, PipelineEventEmitter } from '../events.js';
import { evaluateCondition } from './condition-evaluator.js';
import { buildCallInput } from './call-input.js';
import type { PipelineContext } from './context-propagation.js';

export interface CallRunResult {
  status: StageStatus;
  stageRun: StageRun;
  /** The child pipeline's output — propagated to downstream stages under the stage name. */
  output?: unknown;
}

export interface CallOrchestratorConfig {
  events?: EngineEvents;
  emitter: PipelineEventEmitter;
  spawner?: RunSpawner;
  maxDepth: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class CallOrchestrator {
  constructor(private config: CallOrchestratorConfig) {}

  async run(
    call: CallStage,
    context: PipelineContext,
    stageIndex: number,
    totalStages: number,
    runId: string,
    depth: number,
    signal?: AbortSignal,
  ): Promise<CallRunResult> {
    const pipeline = call.pipeline ?? call.call;
    const startedAt = new Date().toISOString();
    const stageRun: StageRun = {
      id: randomUUID(),
      stage_name: call.call,
      status: 'running',
      started_at: startedAt,
      tasks: [],
    };

    const finish = (status: StageStatus, output?: unknown, skippedReason?: string): CallRunResult => {
      stageRun.status = status;
      stageRun.completed_at = new Date().toISOString();
      if (output !== undefined) stageRun.output = output;
      if (skippedReason) stageRun.skipped_reason = skippedReason;
      this.config.events?.onStageComplete?.({
        stage_name: call.call,
        stage_index: stageIndex,
        total_stages: totalStages,
        status,
        attempts: 1,
        duration_ms: Date.now() - new Date(startedAt).getTime(),
        ...(output !== undefined ? { output } : {}),
        ...(skippedReason ? { skipped_reason: skippedReason } : {}),
      });
      this.config.emitter.emit({ type: 'stage_complete', stageId: stageRun.id, stageName: call.call });
      return { status, stageRun, output };
    };

    // Technical/child failure — record the reason as a failed task so it surfaces
    // in `studio status`, the run JSONL, and the CLI's "Errors:" line.
    const failWith = (reason: string): CallRunResult => {
      const now = new Date().toISOString();
      const taskRun: TaskRun = {
        id: randomUUID(),
        task_name: call.call,
        status: 'failed',
        started_at: startedAt,
        completed_at: now,
        agent_runs: [{
          id: randomUUID(),
          agent_name: `call:${pipeline}`,
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
      stage_name: call.call,
      stage_index: stageIndex,
      total_stages: totalStages,
      max_attempts: 1,
    });
    this.config.emitter.emit({ type: 'stage_start', stageId: stageRun.id, stageName: call.call });

    // Condition — skip the call if false.
    if (call.condition !== undefined) {
      const shouldRun = evaluateCondition(call.condition, {
        input: context.input,
        stageOutputs: context.stageOutputs,
      });
      if (!shouldRun) {
        return finish('skipped', undefined, `condition not met: ${call.condition}`);
      }
    }

    if (signal?.aborted) return finish('cancelled');

    // A call stage spawns a child run — it needs a spawner.
    if (!this.config.spawner) {
      return failWith(
        `Call stage '${call.call}' requires a run spawner, but none is configured. ` +
        `Sub-pipeline calls spawn a child run; construct the engine with a 'spawner'.`
      );
    }

    // Depth guard — mirror map/studio_run's recursion limit.
    if (depth + 1 > this.config.maxDepth) {
      return failWith(
        `Call stage '${call.call}' would spawn a run at depth ${depth + 1}, exceeding maxDepth ${this.config.maxDepth}. ` +
        `Recursive sub-pipeline calls are not allowed at this nesting level.`
      );
    }

    let input: Record<string, unknown>;
    try {
      input = buildCallInput(call, context);
    } catch (err) {
      return failWith(errorMessage(err));
    }

    try {
      const spawn = await this.config.spawner.spawnAndWait({
        pipeline,
        input,
        parentRunId: runId,
        depth: depth + 1,
      });
      return finish('success', spawn.output);
    } catch (err) {
      // Cancelled mid-flight → cancelled, not a real failure.
      if (signal?.aborted) return finish('cancelled');
      return failWith(errorMessage(err));
    }
  }
}
