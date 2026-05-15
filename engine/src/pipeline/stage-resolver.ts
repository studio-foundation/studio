// Resolve stages (sequential)
import type { StageDefinition } from '@studio-foundation/contracts';

export function resolveStages(stages: StageDefinition[]): StageDefinition[] {
  // Return stages in order (sequential execution)
  // Future: could support DAG, parallel stages
  return stages;
}
