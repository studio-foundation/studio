// The abstraction that studio-run tool uses to launch child runs.
// Implementations: DirectEngineSpawner (engine) and HttpApiSpawner (api).

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
}

export interface RunSpawner {
  spawnAndWait(config: SpawnConfig): Promise<SpawnResult>;
}
