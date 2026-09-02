// The abstraction that studio-run tool uses to launch child runs.
// Implementations: DirectEngineSpawner (engine) and HttpApiSpawner (api).

import type { StageStatus } from './stage';
import type { StageRun } from './run';
import type { TokenUsage } from './usage';

/**
 * One stage of a child run, as the parent sees it. The flat `token_usage` says
 * what a child cost; this says what bought it. Without it a caller pricing a
 * fan-out assumes one call per item, under-counting every retried stage.
 */
export interface ChildStageUsage {
  stage: string;
  status: StageStatus;
  /** Attempts the stage's RALPH loop made. 0 for a stage that ran no agent. */
  attempts: number;
  token_usage?: TokenUsage;
}

/**
 * Per-spawn execution overrides. In-process spawners honour them; a remote
 * spawner ignores them, because they name objects that live in this process.
 *
 * Typed as `unknown` on purpose: contracts is a leaf package (INV-04) and the
 * provider registry lives in runner, so the type cannot be named here. The
 * in-process spawner casts it back.
 */
export interface SpawnOverrides {
  /**
   * Replaces the engine's provider registry for this child run and its
   * descendants. Set by a `map` stage running with `batch:` — the substituted
   * registry parks the child's LLM calls in the parent's batch window instead
   * of sending them one by one.
   */
  providerRegistry?: unknown;
}

export interface SpawnConfig {
  pipeline: string;
  input: Record<string, unknown>;
  parentRunId: string;
  depth: number;
  overrides?: SpawnOverrides;
}

export interface SpawnResult {
  run_id: string;
  status: string;
  output: unknown;
  /** What the child run spent, summed over its stages. Absent when unreported. */
  token_usage?: TokenUsage;
  /** The per-stage breakdown behind `token_usage`. Absent when the spawner reports none. */
  stages?: ChildStageUsage[];
}

/**
 * A child run that reached a terminal non-success status. The calls it made were
 * still billed, so the throw carries the same record a successful spawn returns.
 */
export class ChildRunError extends Error {
  constructor(
    message: string,
    public run_id: string,
    public run_status: string,
    public stages: ChildStageUsage[],
    public token_usage?: TokenUsage,
  ) {
    super(message);
    this.name = 'ChildRunError';
  }
}

export interface RunSpawner {
  spawnAndWait(config: SpawnConfig): Promise<SpawnResult>;
}

/**
 * Read a child run's per-stage cost record off its stages. Lives here rather than
 * in either spawner so both report the same shape — a pipeline's cost reporting
 * must not depend on whether its children ran in-process or over the API.
 *
 * Attempts come from the agent runs the stage recorded — one per RALPH attempt —
 * so a stage that retried twice reports 3, not 1.
 */
export function childStageUsage(stages: StageRun[]): ChildStageUsage[] {
  return stages.map((stage) => ({
    stage: stage.stage_name,
    status: stage.status,
    attempts: stage.tasks.reduce(
      (max, task) => task.agent_runs.reduce((n, run) => Math.max(n, run.attempt), max),
      0,
    ),
    ...(stage.token_usage ? { token_usage: stage.token_usage } : {}),
  }));
}

/**
 * The error a terminal child run actually died of, dug out of its last failed
 * stage. Without it a caller sees only the status, which names no cause.
 */
export function childRunErrorMessage(stages: StageRun[]): string | undefined {
  const lastFailed = [...stages]
    .reverse()
    .find((s) => s.status === 'failed' || s.status === 'rejected' || s.status === 'cancelled');
  return lastFailed?.tasks
    .flatMap((t) => t.agent_runs)
    .reverse()
    .find((a) => a.error)?.error;
}
