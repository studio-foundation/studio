# Feedback Loop Groups — QA → Code Pipeline Loops

## Problem

When QA rejects code (status `rejected`), the pipeline stops. We want the coder to automatically correct errors: QA detects issues, coder receives feedback, corrects, QA re-reviews. Until approval or max iterations exhausted.

## Architecture

### Group Concept

A group is a set of stages forming a loop. The last stage is the "gate" — if its post-validator returns `rejected`, the group restarts from the beginning with feedback injected into context.

```
Linear stages:           brief-analysis → implementation-plan
                                                           ↓
Group (max 3 loops):                           code-generation → qa-review
                                                     ↑               │
                                                     └── if rejected ┘
```

### Group Rules

1. A group contains 2+ stages executed sequentially
2. The LAST stage is the gate (decides whether to loop)
3. Gate `rejected` → restart group from first stage with feedback
4. Gate `success` → exit group, continue pipeline
5. Gate `failed` (technical error) → pipeline stops
6. `max_iterations` prevents infinite loops (default: 3)
7. Max iterations reached without approval → pipeline stops with `rejected`

### Context Between Iterations

Each group iteration:
- Outputs from stages BEFORE the group remain stable
- Outputs from stages WITHIN the group are CLEARED between iterations
- Gate feedback (QA issues) is ADDED to the first stage's context
- Iteration number is visible in context

## Implementation Approach

### Types (contracts/src/pipeline.ts)

- Add `PipelineEntry = StageDefinition | StageGroup` union type
- Add `StageGroup` interface with `group`, `max_iterations`, `stages`
- Add `isStageGroup()` type guard
- Change `PipelineDefinition.stages` from `StageDefinition[]` to `PipelineEntry[]`

### Loader (engine/src/pipeline/loader.ts)

- Detect groups by presence of `group` key in YAML entries
- Parse group stages with existing `parseStage` logic
- Default `max_iterations` to 3

### Context Propagation (engine/src/pipeline/context-propagation.ts)

- Add `GroupFeedback` interface to `PipelineContext`
- Add `group_feedback` case in `getContextForStage()` switch
- Feedback text includes iteration number, rejection reason, and detailed issues
- Mutations use existing pattern (mutate context in-place via Map)

### Engine (engine/src/engine.ts)

- Refactor current inline stage execution into `runStage()` private method
- Add `runGroup()` private method implementing the iteration loop
- Modify `run()` to dispatch between `isStageGroup` → `runGroup()` and stages → `runStage()`
- Group clears its stage outputs between iterations via `stageOutputs.delete()`

### Events (engine/src/events.ts)

- Add `onGroupStart`, `onGroupIteration`, `onGroupFeedback`, `onGroupComplete` to `EngineEvents`
- Add corresponding event types to `PipelineEvent` union for the generic bus

### CLI (cli/src/output/progress.ts)

- Display feedback loop iteration markers
- Show rejection reason on QA feedback
- Show iteration count on group completion

### Pipeline YAML (engine/pipelines/feature-builder.pipeline.yaml)

- Wrap code-generation + qa-review in a group named `implementation-review`
- Add `group_feedback` to code-generation's context includes

## Adaptations from Spec

1. **Map API**: `stageOutputs` uses `Map<string, unknown>` — group cleanup uses `.delete()` not `delete obj[key]`
2. **Mutation pattern**: Context helpers mutate in-place (consistent with `addStageOutput`)
3. **Dual events**: Group events added to both `EngineEvents` callbacks and `PipelineEvent` bus
4. **PipelineInput type**: Input can be string or structured object, feedback injection handles both

## Files Changed

1. `contracts/src/pipeline.ts` — StageGroup, PipelineEntry, isStageGroup
2. `engine/src/pipeline/loader.ts` — Parse groups in YAML
3. `engine/src/pipeline/context-propagation.ts` — GroupFeedback, group_feedback context
4. `engine/src/engine.ts` — Extract runStage(), implement runGroup(), modify run()
5. `engine/src/events.ts` — Group event types
6. `engine/pipelines/feature-builder.pipeline.yaml` — Wrap stages in group
7. `cli/src/output/progress.ts` — Display group events
8. `engine/tests/group-loop.test.ts` — Feedback loop tests
