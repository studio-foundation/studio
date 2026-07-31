// The abstraction that studio-run tool uses to launch child runs.
// Implementations: DirectEngineSpawner (engine) and HttpApiSpawner (api).

import type { TokenUsage } from './usage';

export interface SpawnConfig {
  pipeline: string;
  input: Record<string, unknown>;
  parentRunId: string;
  depth: number;
}

export interface SpawnResult {
  run_id: string;
  status: string;
  output: unknown;
  /** What the child run spent, summed over its stages. Absent when unreported. */
  token_usage?: TokenUsage;
}

export interface RunSpawner {
  spawnAndWait(config: SpawnConfig): Promise<SpawnResult>;
}
