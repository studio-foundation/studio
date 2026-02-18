// Resolve stages (sequential for v7)
import type { StageDefinition } from '@studio/contracts';

export function resolveStages(stages: StageDefinition[]): StageDefinition[] {
  // For v7: just return stages in order (sequential execution)
  // Future: could support DAG, parallel stages
  return stages;
}
