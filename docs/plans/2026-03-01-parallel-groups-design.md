# STU-128 — Parallel Groups Design

**Date:** 2026-03-01
**Ticket:** [STU-128](https://linear.app/studioag/issue/STU-128/parallelisme-dans-les-groups-mode-parallel-pour-stages-independants)
**Status:** Approved

## Problem

Group stages currently execute sequentially. Independent tasks (e.g. analyzing 5 files in parallel, launching multiple agents on distinct sub-problems) create unnecessary bottlenecks.

## Solution

Add `mode: parallel` to `StageGroup`. Default remains `sequential` — no breaking change.

## Type Changes (`contracts/src/pipeline.ts`)

```typescript
export interface StageGroup {
  group: string;
  max_iterations: number;
  mode?: 'sequential' | 'parallel';         // default: 'sequential'
  on_failure?: 'fail-fast' | 'collect-all'; // parallel only, default: 'fail-fast'
  stages: StageDefinition[];
}
```

## YAML Format

```yaml
- group: analyze-files
  mode: parallel
  on_failure: fail-fast   # optional, default: fail-fast
  stages:
    - name: analyze-auth
      kind: analysis
      agent: analyst
      context:
        include: [input]
    - name: analyze-payments
      kind: analysis
      agent: analyst
      context:
        include: [input]
    - name: analyze-inventory
      kind: analysis
      agent: analyst
      context:
        include: [input]
```

## Architecture (`engine/src/engine.ts`)

### Dispatcher pattern

`runGroup` becomes a dispatcher, current implementation renamed to `runGroupSequential`:

```typescript
private async runGroup(...): Promise<GroupResult> {
  if (group.mode === 'parallel') {
    return this.runGroupParallel(group, context, ...);
  }
  return this.runGroupSequential(group, context, ...);
}
```

### `runGroupParallel` logic

1. Emit `onGroupStart` (same event, mode-agnostic)
2. Emit `onGroupIteration` (iteration=1, only once)
3. Resolve `previousStageName` from pre-group context (last stage before the group)
4. Launch all stages concurrently via `executeStage()`:
   - **fail-fast**: shared `AbortController` — abort remaining stages on first failure
   - **collect-all**: `Promise.allSettled()` — wait for all stages regardless
5. Collect results
6. Derive group status:
   - All success → `success`, merge all outputs into pipeline context
   - Any `cancelled` → `cancelled`
   - Any `failed` or `rejected` → `failed` (rejected treated as failed in parallel mode)
   - `collect-all`: merge successful stage outputs even on partial failure
7. Emit `onGroupComplete`

### Context snapshot for parallel stages

`executeStage` does not mutate `PipelineContext` — the caller (`runGroup`) is responsible for calling `addStageOutput`. This means concurrent `executeStage` calls are safe: each reads the same pre-group snapshot of `PipelineContext` without interference.

Each parallel stage receives:
- The same `previousStageName` (last stage before the group, not a sibling)
- The same `PipelineContext` state as at group entry

Parallel stages **cannot see each other's outputs** during execution. This is intentional and enforced by design.

### Context merging after success

After a successful parallel group, outputs are merged in stage definition order (deterministic, not execution order):

```typescript
for (const stage of group.stages) {
  const result = resultMap.get(stage.name);
  if (result?.lastAgentOutput !== undefined) {
    addStageOutput(context, stage.name, result.lastAgentOutput);
  }
  if (result?.toolCalls?.length) {
    addStageToolResults(context, stage.name, result.toolCalls);
  }
}
```

Subsequent pipeline stages can access these via `all_stage_outputs`.

## Loader validation (`engine/src/pipeline/loader.ts`)

- Parse `mode` and `on_failure` from YAML group entry
- If `mode: parallel` and `max_iterations > 1`: log warning, treat as 1 iteration
- `on_failure` is ignored for sequential groups (no validation error, just unused)

## Events — no breaking changes

`onGroupStart`, `onGroupIteration`, `onGroupComplete` continue with the same types. In parallel mode:
- `onGroupIteration` emitted once (iteration=1)
- `onGroupFeedback` never emitted (no feedback loop in parallel mode)

No new events added (YAGNI).

## Invariants

- **INV-02** (ralph ne connaît pas runner): unaffected — each stage still has its own independent ralph loop
- **INV-03** (runner ne valide pas): unaffected — validation stays in ralph
- **INV-04** (contracts is a leaf): only adding optional fields to `StageGroup`, zero new dependencies

## Test Plan (`engine/tests/unit/group-parallel.test.ts`)

| Test | Expected |
|------|----------|
| 3 stages parallel, all success | group success, all outputs in context |
| fail-fast: one stage fails, others cancelled | group failed, AbortSignal propagated |
| collect-all: one stage fails, others finish | group failed after all stages complete |
| rejected treated as failed | post-validation rejection → group failed |
| `max_iterations > 1` with parallel | ignored, no loop |
| sequential mode unaffected | existing `group-loop.test.ts` tests pass |
| context snapshot: parallel stages don't see siblings | stage B has no output from stage A in context |
| outputs merged after success | pipeline context contains all stage outputs |
| events emitted correctly | `onGroupStart` + `onGroupIteration(1)` + `onGroupComplete` |

Fixtures: `parallel-test.pipeline.yaml` with `mode: parallel`, 3 stages. Reuse existing agents/contracts from `tests/fixtures/`.
