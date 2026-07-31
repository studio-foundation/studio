// The abstraction that studio-run tool uses to launch child runs.
// Implementations: DirectEngineSpawner (engine) and HttpApiSpawner (api).

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
}

export interface RunSpawner {
  spawnAndWait(config: SpawnConfig): Promise<SpawnResult>;
}
