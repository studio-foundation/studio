// The abstraction that studio-run tool uses to launch child runs.
// Implementations: DirectEngineSpawner (engine) and HttpApiSpawner (api).

import type { StageStatus } from './stage';
import type { TokenUsage } from './usage';

/**
 * One stage of a child run, as the parent sees it.
 *
 * The flat `token_usage` answers "what did this child cost"; this answers "what
 * bought it" — which stage, how many RALPH attempts it took, and what those
 * attempts spent. A caller pricing a fan-out otherwise has to assume one call
 * per item, which under-counts every retried stage.
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
 * A child run that reached a terminal non-success status.
 *
 * The calls a failed child made were still billed, so the throw carries the same
 * record a successful spawn returns. Without it a caller sees only a message and
 * prices the whole item as one unpriced call.
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
