// Contract coverage — which stages of a pipeline run with nothing to validate
// against.
//
// `contract:` is optional on a stage. When it is absent the RALPH loop keeps
// only its terminal-error check: no schema, no `tool_calls` floor, no rejection
// detection. That is legitimate (a scratch pipeline, a stage nothing downstream
// reads) but it is silent, and a `.studio/contracts/` directory next door makes
// it look like validation is in force when it is not (STU-703). Callers use
// this to say so out loud — a warning, never a failure.

import type { PipelineDefinition, PipelineEntry } from '@studio-foundation/contracts';
import { isStageGroup, isMapStage, isCallStage } from '@studio-foundation/contracts';

/** A leaf stage that declares no `contract:`. */
export interface UnvalidatedStage {
  stage: string;
  /** Name of the enclosing group, when the stage lives inside one. */
  group?: string;
}

/**
 * Every leaf stage without a `contract:`, in pipeline order.
 *
 * Only stages that *can* carry a contract are considered: `map` and `call`
 * entries have no `contract` field at all — their validation is the
 * sub-pipeline's own — so they are never reported.
 */
export function findUnvalidatedStages(entries: PipelineEntry[]): UnvalidatedStage[] {
  const found: UnvalidatedStage[] = [];
  for (const entry of entries) {
    if (isMapStage(entry) || isCallStage(entry)) continue;
    if (isStageGroup(entry)) {
      for (const stage of entry.stages) {
        if (!stage.contract) found.push({ stage: stage.name, group: entry.group });
      }
    } else if (!entry.contract) {
      found.push({ stage: entry.name });
    }
  }
  return found;
}

/** Same, for a whole pipeline definition. */
export function findUnvalidatedStagesInPipeline(pipeline: PipelineDefinition): UnvalidatedStage[] {
  return findUnvalidatedStages(pipeline.stages);
}

/** One human-readable line per unvalidated stage, for a CLI to print. */
export function formatUnvalidatedStages(stages: UnvalidatedStage[]): string[] {
  return stages.map(
    ({ stage, group }) =>
      `stage '${stage}'${group ? ` (in group '${group}')` : ''} has no contract — output is not validated`
  );
}
