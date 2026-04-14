# Stage Conditions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an optional `condition` field to stage definitions that skips stages when the condition evaluates to false, based on pipeline input or previous stage output.

**Architecture:** The condition string is evaluated by a new pure `condition-evaluator.ts` module in `@studio-foundation/engine`. The check is an early return inside `StageExecutor.execute()`, before any agent loading or ralph loop. `GroupOrchestrator` handles the resulting `skipped` status without stopping the group.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces. No new dependencies.

**Design doc:** `docs/plans/2026-03-06-stage-conditions-design.md`

---

## Task 1: Add `condition` field to `StageDefinition`

**Files:**
- Modify: `contracts/src/pipeline.ts`

**Step 1: Add the field**

In `contracts/src/pipeline.ts`, add `condition?: string` to `StageDefinition` after `name`:

```typescript
export interface StageDefinition {
  name: string;
  condition?: string;   // e.g. "input.meals_count >= 6" or "stages.foo.output.count > 0"
  kind?: StageKind;
  // ... rest unchanged
}
```

**Step 2: Build to verify no type errors**

```bash
pnpm build
```

Expected: all packages build successfully.

**Step 3: Commit**

```bash
git add contracts/src/pipeline.ts
git commit -m "feat(contracts): add condition field to StageDefinition"
```

---

## Task 2: Implement `condition-evaluator.ts` with TDD

**Files:**
- Create: `engine/src/pipeline/condition-evaluator.test.ts`
- Create: `engine/src/pipeline/condition-evaluator.ts`

### Step 1: Write the failing tests

Create `engine/src/pipeline/condition-evaluator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { evaluateCondition } from './condition-evaluator.js';

const makeContext = (
  input: Record<string, unknown> | string = {},
  stageOutputs: Map<string, unknown> = new Map(),
) => ({ input, stageOutputs });

describe('evaluateCondition — input namespace', () => {
  it('returns true when input field equals condition value (>=)', () => {
    const ctx = makeContext({ meals_count: 6 });
    expect(evaluateCondition('input.meals_count >= 6', ctx)).toBe(true);
  });

  it('returns false when input field is below threshold', () => {
    const ctx = makeContext({ meals_count: 5 });
    expect(evaluateCondition('input.meals_count >= 6', ctx)).toBe(false);
  });

  it('returns true for strict greater than when value exceeds', () => {
    const ctx = makeContext({ meals_count: 7 });
    expect(evaluateCondition('input.meals_count > 6', ctx)).toBe(true);
  });

  it('returns false for strict greater than when value equals threshold', () => {
    const ctx = makeContext({ meals_count: 6 });
    expect(evaluateCondition('input.meals_count > 6', ctx)).toBe(false);
  });

  it('returns true for less than', () => {
    const ctx = makeContext({ priority: 2 });
    expect(evaluateCondition('input.priority < 3', ctx)).toBe(true);
  });

  it('returns true for less than or equal', () => {
    const ctx = makeContext({ priority: 3 });
    expect(evaluateCondition('input.priority <= 3', ctx)).toBe(true);
  });

  it('returns true for == equality', () => {
    const ctx = makeContext({ mode: 'fast' });
    expect(evaluateCondition("input.mode == fast", ctx)).toBe(true);
  });

  it('returns true for === strict equality with number', () => {
    const ctx = makeContext({ count: 0 });
    expect(evaluateCondition('input.count === 0', ctx)).toBe(true);
  });

  it('returns true for != inequality', () => {
    const ctx = makeContext({ mode: 'slow' });
    expect(evaluateCondition("input.mode != fast", ctx)).toBe(true);
  });

  it('returns true for !== strict inequality', () => {
    const ctx = makeContext({ count: 1 });
    expect(evaluateCondition('input.count !== 0', ctx)).toBe(true);
  });

  it('returns false when input field is missing', () => {
    const ctx = makeContext({ other_field: 5 });
    expect(evaluateCondition('input.meals_count >= 6', ctx)).toBe(false);
  });

  it('returns false when input is a string (not an object)', () => {
    const ctx = makeContext('plain string input');
    expect(evaluateCondition('input.meals_count >= 6', ctx)).toBe(false);
  });

  it('supports nested field paths', () => {
    const ctx = makeContext({ config: { threshold: 10 } });
    expect(evaluateCondition('input.config.threshold > 5', ctx)).toBe(true);
  });
});

describe('evaluateCondition — stages namespace', () => {
  const stageOutputs = new Map<string, unknown>([
    ['entity-extraction', { counts: { OTHER: 3, PERSON: 1 }, total: 4 }],
    ['stage-with-zero', { count: 0 }],
    ['analysis', { score: 0.85 }],
  ]);

  it('returns true when stage output field is above threshold', () => {
    const ctx = makeContext({}, stageOutputs);
    expect(evaluateCondition('stages.entity-extraction.output.counts.OTHER > 0', ctx)).toBe(true);
  });

  it('returns false when stage output field is zero', () => {
    const ctx = makeContext({}, stageOutputs);
    expect(evaluateCondition('stages.stage-with-zero.output.count > 0', ctx)).toBe(false);
  });

  it('supports stage names with hyphens', () => {
    const ctx = makeContext({}, stageOutputs);
    expect(evaluateCondition('stages.entity-extraction.output.total >= 3', ctx)).toBe(true);
  });

  it('returns false when stage does not exist in outputs', () => {
    const ctx = makeContext({}, stageOutputs);
    expect(evaluateCondition('stages.nonexistent.output.count > 0', ctx)).toBe(false);
  });

  it('returns false when nested field path does not exist', () => {
    const ctx = makeContext({}, stageOutputs);
    expect(evaluateCondition('stages.entity-extraction.output.missing.deep > 0', ctx)).toBe(false);
  });

  it('supports float comparisons', () => {
    const ctx = makeContext({}, stageOutputs);
    expect(evaluateCondition('stages.analysis.output.score >= 0.8', ctx)).toBe(true);
  });
});

describe('evaluateCondition — edge cases', () => {
  it('returns false for an unparseable expression (no operator)', () => {
    const ctx = makeContext({ x: 1 });
    expect(evaluateCondition('input.x', ctx)).toBe(false);
  });

  it('handles whitespace around operator', () => {
    const ctx = makeContext({ n: 5 });
    expect(evaluateCondition('input.n   >=   5', ctx)).toBe(true);
  });

  it('>=6 is treated correctly (no space before value)', () => {
    const ctx = makeContext({ n: 6 });
    expect(evaluateCondition('input.n >= 6', ctx)).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
pnpm --filter @studio-foundation/engine exec vitest run src/pipeline/condition-evaluator.test.ts
```

Expected: fails with "Cannot find module './condition-evaluator.js'"

**Step 3: Write the implementation**

Create `engine/src/pipeline/condition-evaluator.ts`:

```typescript
// Secure condition evaluator — no eval(), no external dependencies.
// Supported syntax:
//   input.<field.path>                      compared to a literal
//   stages.<stage-name>.output.<field.path> compared to a literal
// Operators: ===, !==, >=, <=, ==, !=, >, <
// Returns false for any undefined/invalid path (skip-safe).

import type { PipelineInput } from './context-propagation.js';

// Longest-first to avoid '>' matching inside '>='
const OPERATORS = ['===', '!==', '>=', '<=', '==', '!=', '>', '<'] as const;
type Operator = typeof OPERATORS[number];

export function evaluateCondition(
  condition: string,
  context: { input: PipelineInput; stageOutputs: Map<string, unknown> },
): boolean {
  const trimmed = condition.trim();

  // Find operator (longest-first)
  let operator: Operator | undefined;
  let lhsStr = '';
  let rhsStr = '';

  for (const op of OPERATORS) {
    const idx = trimmed.indexOf(op);
    if (idx !== -1) {
      operator = op;
      lhsStr = trimmed.slice(0, idx).trim();
      rhsStr = trimmed.slice(idx + op.length).trim();
      break;
    }
  }

  if (!operator || !lhsStr || !rhsStr) return false;

  const lhsValue = resolveLhs(lhsStr, context);
  if (lhsValue === undefined) return false;

  const rhsValue = parseRhs(rhsStr);
  return compare(lhsValue, operator, rhsValue);
}

function resolveLhs(
  lhs: string,
  context: { input: PipelineInput; stageOutputs: Map<string, unknown> },
): unknown {
  if (lhs.startsWith('input.')) {
    const fieldPath = lhs.slice('input.'.length);
    if (typeof context.input !== 'object' || context.input === null) return undefined;
    return traversePath(context.input as Record<string, unknown>, fieldPath);
  }

  if (lhs.startsWith('stages.')) {
    // Format: stages.<stage-name>.output.<field.path>
    // Stage names can contain hyphens — split on first '.output.' occurrence
    const rest = lhs.slice('stages.'.length);
    const outputMarker = '.output.';
    const markerIdx = rest.indexOf(outputMarker);
    if (markerIdx === -1) return undefined;

    const stageName = rest.slice(0, markerIdx);
    const fieldPath = rest.slice(markerIdx + outputMarker.length);

    const stageOutput = context.stageOutputs.get(stageName);
    if (stageOutput === undefined || stageOutput === null) return undefined;

    return traversePath(stageOutput as Record<string, unknown>, fieldPath);
  }

  return undefined;
}

function traversePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function parseRhs(rhs: string): unknown {
  // Number (int or float, optional leading minus)
  if (/^-?\d+(\.\d+)?$/.test(rhs)) return Number(rhs);
  // Boolean
  if (rhs === 'true') return true;
  if (rhs === 'false') return false;
  // Quoted string
  if ((rhs.startsWith('"') && rhs.endsWith('"')) || (rhs.startsWith("'") && rhs.endsWith("'"))) {
    return rhs.slice(1, -1);
  }
  // Plain string (e.g. input.mode == fast)
  return rhs;
}

function compare(lhs: unknown, op: Operator, rhs: unknown): boolean {
  // Coerce lhs to number if rhs is a number and lhs is a string
  let lhsCoerced: unknown = lhs;
  if (typeof rhs === 'number' && typeof lhs === 'string') {
    const n = Number(lhs);
    if (!isNaN(n)) lhsCoerced = n;
  }

  switch (op) {
    case '>':   return typeof lhsCoerced === 'number' && typeof rhs === 'number' && lhsCoerced > rhs;
    case '>=':  return typeof lhsCoerced === 'number' && typeof rhs === 'number' && lhsCoerced >= rhs;
    case '<':   return typeof lhsCoerced === 'number' && typeof rhs === 'number' && lhsCoerced < rhs;
    case '<=':  return typeof lhsCoerced === 'number' && typeof rhs === 'number' && lhsCoerced <= rhs;
    // eslint-disable-next-line eqeqeq
    case '==':  return lhsCoerced == rhs;
    case '===': return lhsCoerced === rhs;
    // eslint-disable-next-line eqeqeq
    case '!=':  return lhsCoerced != rhs;
    case '!==': return lhsCoerced !== rhs;
    default:    return false;
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio-foundation/engine exec vitest run src/pipeline/condition-evaluator.test.ts
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add engine/src/pipeline/condition-evaluator.ts engine/src/pipeline/condition-evaluator.test.ts
git commit -m "feat(engine): add condition-evaluator — secure expression parser for stage conditions"
```

---

## Task 3: Add condition check to StageExecutor + integration tests

**Files:**
- Create: `engine/src/__tests__/engine.conditions.test.ts`
- Modify: `engine/src/pipeline/stage-executor.ts`

### Step 1: Write the failing integration test

Create `engine/src/__tests__/engine.conditions.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { PipelineEngine } from '../engine.js';
import type { PipelineDefinition } from '@studio-foundation/contracts';

// Mock the runner so we can inspect which stages actually ran
vi.mock('@studio-foundation/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@studio-foundation/runner')>();
  return {
    ...actual,
    runScript: vi.fn(),
  };
});

import { runScript } from '@studio-foundation/runner';

const FIXTURES_DIR = new URL('./__fixtures__/script-stage', import.meta.url).pathname;

function makeEngine() {
  return new PipelineEngine({
    configsDir: FIXTURES_DIR,
    providerRegistry: {} as any,
  });
}

function mockScriptSuccess(output: Record<string, unknown> = { result: 'ok' }) {
  vi.mocked(runScript).mockResolvedValue({
    output,
    tool_calls: [],
    tool_calls_count: 0,
    duration_ms: 10,
  });
}

describe('engine — stage conditions', () => {
  it('skips a stage when input condition is false', async () => {
    mockScriptSuccess();

    const pipeline: PipelineDefinition = {
      name: 'test-conditions',
      description: 'test',
      version: 1,
      stages: [
        {
          name: 'always-runs',
          executor: 'script',
          script: 'scripts/parse.py',
          runtime: 'shell',
        },
        {
          name: 'conditional-stage',
          executor: 'script',
          script: 'scripts/parse.py',
          runtime: 'shell',
          condition: 'input.meals_count >= 6',
        },
      ],
    };

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: pipeline,
      input: { meals_count: 3 },  // condition is false — stage should skip
    });

    expect(result.status).toBe('success');
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0]?.status).toBe('success');
    expect(result.stages[1]?.status).toBe('skipped');
    // Script was only called once (for always-runs, not conditional-stage)
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);
  });

  it('runs a stage when input condition is true', async () => {
    mockScriptSuccess();

    const pipeline: PipelineDefinition = {
      name: 'test-conditions-true',
      description: 'test',
      version: 1,
      stages: [
        {
          name: 'conditional-stage',
          executor: 'script',
          script: 'scripts/parse.py',
          runtime: 'shell',
          condition: 'input.meals_count >= 6',
        },
      ],
    };

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: pipeline,
      input: { meals_count: 7 },  // condition is true — stage should run
    });

    expect(result.status).toBe('success');
    expect(result.stages[0]?.status).toBe('success');
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);
  });

  it('skips a stage based on previous stage output', async () => {
    // First call returns extraction result, second call would be entity-resolution
    vi.mocked(runScript).mockResolvedValueOnce({
      output: { counts: { OTHER: 0, PERSON: 2 } },
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 10,
    });

    const pipeline: PipelineDefinition = {
      name: 'test-conditions-stage-output',
      description: 'test',
      version: 1,
      stages: [
        {
          name: 'entity-extraction',
          executor: 'script',
          script: 'scripts/extract.py',
          runtime: 'shell',
          context: { include: ['input'] },
        },
        {
          name: 'entity-resolution-OTHER',
          executor: 'script',
          script: 'scripts/resolve.py',
          runtime: 'shell',
          condition: 'stages.entity-extraction.output.counts.OTHER > 0',
          context: { include: ['all_stage_outputs'] },
        },
      ],
    };

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: pipeline,
      input: 'extract entities',
    });

    expect(result.status).toBe('success');
    expect(result.stages[0]?.status).toBe('success');
    expect(result.stages[1]?.status).toBe('skipped');  // counts.OTHER is 0
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);  // only extraction ran
  });

  it('pipeline continues after skipped stage', async () => {
    mockScriptSuccess({ final: 'result' });

    const pipeline: PipelineDefinition = {
      name: 'test-skip-continues',
      description: 'test',
      version: 1,
      stages: [
        {
          name: 'skipped-stage',
          executor: 'script',
          script: 'scripts/parse.py',
          runtime: 'shell',
          condition: 'input.run_optional >= 1',
        },
        {
          name: 'final-stage',
          executor: 'script',
          script: 'scripts/finalize.py',
          runtime: 'shell',
        },
      ],
    };

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: pipeline,
      input: { run_optional: 0 },
    });

    expect(result.status).toBe('success');
    expect(result.stages[0]?.status).toBe('skipped');
    expect(result.stages[1]?.status).toBe('success');
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);  // only final-stage
  });
});
```

**Step 2: Run to verify it fails**

```bash
pnpm --filter @studio-foundation/engine exec vitest run src/__tests__/engine.conditions.test.ts
```

Expected: tests fail — skipped stages show `success` (condition not yet evaluated).

**Step 3: Add condition check to `StageExecutor.execute()`**

In `engine/src/pipeline/stage-executor.ts`:

1. Add the import at the top with the other local imports:
```typescript
import { evaluateCondition } from './condition-evaluator.js';
```

2. In the `execute()` method, insert the condition check right after the `emitter.emit({ type: 'stage_start' ... })` call (currently around line 126), before loading the agent:

```typescript
// Evaluate condition — skip stage if false
if (stageDef.condition !== undefined) {
  const shouldRun = evaluateCondition(stageDef.condition, {
    input: pipelineContext.input,
    stageOutputs: pipelineContext.stageOutputs,
  });
  if (!shouldRun) {
    stageRun.status = 'skipped';
    stageRun.completed_at = new Date().toISOString();
    stageRun.tasks = [];
    this.config.events?.onStageComplete?.({
      stage_name: stageDef.name,
      stage_index: stageIndex,
      total_stages: totalStages,
      status: 'skipped',
      attempts: 0,
      duration_ms: 0,
    });
    this.config.emitter.emit({ type: 'stage_complete', stageId: stageRunId, stageName: stageDef.name });
    return { stageRun, status: 'skipped' };
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio-foundation/engine exec vitest run src/__tests__/engine.conditions.test.ts
```

Expected: all 4 tests pass.

**Step 5: Run the full engine test suite to verify no regressions**

```bash
pnpm --filter @studio-foundation/engine test
```

Expected: all tests pass.

**Step 6: Commit**

```bash
git add engine/src/pipeline/stage-executor.ts engine/src/__tests__/engine.conditions.test.ts
git commit -m "feat(engine): skip stages when condition evaluates to false [STU-239]"
```

---

## Task 4: Handle `skipped` in GroupOrchestrator — sequential

**Files:**
- Create: `engine/src/__tests__/engine.conditions-group.test.ts`
- Modify: `engine/src/pipeline/group-orchestrator.ts`

### Step 1: Write failing tests for group + conditions

Create `engine/src/__tests__/engine.conditions-group.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { PipelineEngine } from '../engine.js';
import type { PipelineDefinition } from '@studio-foundation/contracts';

vi.mock('@studio-foundation/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@studio-foundation/runner')>();
  return {
    ...actual,
    runScript: vi.fn(),
  };
});

import { runScript } from '@studio-foundation/runner';

const FIXTURES_DIR = new URL('./__fixtures__/script-stage', import.meta.url).pathname;

function makeEngine() {
  return new PipelineEngine({
    configsDir: FIXTURES_DIR,
    providerRegistry: {} as any,
  });
}

describe('engine — conditions inside sequential groups', () => {
  it('skips a conditional stage inside a sequential group', async () => {
    vi.mocked(runScript).mockResolvedValue({
      output: { done: true },
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 10,
    });

    const pipeline: PipelineDefinition = {
      name: 'test-group-conditions',
      description: 'test',
      version: 1,
      stages: [
        {
          group: 'processing',
          max_iterations: 1,
          stages: [
            {
              name: 'always-runs',
              executor: 'script',
              script: 'scripts/run.py',
              runtime: 'shell',
            },
            {
              name: 'conditional-in-group',
              executor: 'script',
              script: 'scripts/optional.py',
              runtime: 'shell',
              condition: 'input.optional >= 1',
            },
          ],
        },
      ],
    };

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: pipeline,
      input: { optional: 0 },
    });

    expect(result.status).toBe('success');
    expect(result.stages[0]?.status).toBe('success');
    expect(result.stages[1]?.status).toBe('skipped');
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);
  });

  it('marks group as skipped when all stages in sequential group are skipped', async () => {
    vi.mocked(runScript).mockResolvedValue({
      output: { done: true },
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 10,
    });

    // A stage after the group should still run
    const pipeline: PipelineDefinition = {
      name: 'test-all-skipped-group',
      description: 'test',
      version: 1,
      stages: [
        {
          group: 'optional-processing',
          max_iterations: 1,
          stages: [
            {
              name: 'optional-a',
              executor: 'script',
              script: 'scripts/a.py',
              runtime: 'shell',
              condition: 'input.run_optional >= 1',
            },
            {
              name: 'optional-b',
              executor: 'script',
              script: 'scripts/b.py',
              runtime: 'shell',
              condition: 'input.run_optional >= 1',
            },
          ],
        },
        {
          name: 'post-group-stage',
          executor: 'script',
          script: 'scripts/final.py',
          runtime: 'shell',
        },
      ],
    };

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: pipeline,
      input: { run_optional: 0 },
    });

    expect(result.status).toBe('success');
    // Both group stages skipped
    expect(result.stages[0]?.status).toBe('skipped');
    expect(result.stages[1]?.status).toBe('skipped');
    // Post-group stage ran
    expect(result.stages[2]?.status).toBe('success');
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);  // only post-group-stage
  });
});
```

**Step 2: Run to verify tests fail**

```bash
pnpm --filter @studio-foundation/engine exec vitest run src/__tests__/engine.conditions-group.test.ts
```

Expected: "all stages skipped → group skipped" test fails (group returns `success` instead of passing through as non-fatal).

**Step 3: Update sequential path in `GroupOrchestrator.runSequential()`**

In `engine/src/pipeline/group-orchestrator.ts`, in the `runSequential` method:

1. Add `anyStageExecuted` tracking after the existing `let groupSucceeded = true;`:

```typescript
let groupSucceeded = true;
let anyStageExecuted = false;
```

2. Inside the stage loop, after collecting the result (right before the `cancelled` check), add:

```typescript
if (result.status !== 'skipped') anyStageExecuted = true;
```

3. `skipped` stages should not stop the group — they don't match `cancelled`, `failed`, or `rejected`, so no new code needed there. But you also want to avoid adding output for skipped stages. The existing `if (result.lastAgentOutput !== undefined)` guard already handles this (skipped stages return no output).

4. At the `groupSucceeded` branch (near end of while loop), change `'success'` to derive from `anyStageExecuted`:

```typescript
if (groupSucceeded) {
  const groupStatus = anyStageExecuted ? 'success' : 'skipped';
  this.config.events?.onGroupComplete?.({
    group_name: group.group,
    iterations: iteration,
    status: groupStatus,
  });
  this.config.emitter.emit({
    type: 'group_complete',
    groupName: group.group,
    iterations: iteration,
    status: groupStatus,
  });
  return {
    status: groupStatus,
    stageRuns: allStageRuns,
    stagesExecuted: group.stages.length,
    context,
    totalTokensDelta,
    totalToolCallsDelta,
  };
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio-foundation/engine exec vitest run src/__tests__/engine.conditions-group.test.ts
```

Expected: all tests pass.

**Step 5: Run full engine suite**

```bash
pnpm --filter @studio-foundation/engine test
```

Expected: all tests pass.

**Step 6: Commit**

```bash
git add engine/src/pipeline/group-orchestrator.ts engine/src/__tests__/engine.conditions-group.test.ts
git commit -m "feat(engine): handle skipped stages in sequential group orchestration [STU-239]"
```

---

## Task 5: Handle `skipped` in GroupOrchestrator — parallel

**Files:**
- Modify: `engine/src/__tests__/engine.conditions-group.test.ts` (add parallel test)
- Modify: `engine/src/pipeline/group-orchestrator.ts` (parallel path)

### Step 1: Add failing test for parallel group

Append to `engine/src/__tests__/engine.conditions-group.test.ts`:

```typescript
describe('engine — conditions inside parallel groups', () => {
  it('marks parallel group as skipped when all stages are skipped', async () => {
    vi.mocked(runScript).mockResolvedValue({
      output: { done: true },
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 10,
    });

    const pipeline: PipelineDefinition = {
      name: 'test-parallel-all-skipped',
      description: 'test',
      version: 1,
      stages: [
        {
          group: 'optional-parallel',
          max_iterations: 1,
          mode: 'parallel',
          stages: [
            {
              name: 'parallel-a',
              executor: 'script',
              script: 'scripts/a.py',
              runtime: 'shell',
              condition: 'input.enabled >= 1',
            },
            {
              name: 'parallel-b',
              executor: 'script',
              script: 'scripts/b.py',
              runtime: 'shell',
              condition: 'input.enabled >= 1',
            },
          ],
        },
        {
          name: 'post-group',
          executor: 'script',
          script: 'scripts/final.py',
          runtime: 'shell',
        },
      ],
    };

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: pipeline,
      input: { enabled: 0 },
    });

    expect(result.status).toBe('success');
    expect(result.stages[0]?.status).toBe('skipped');
    expect(result.stages[1]?.status).toBe('skipped');
    expect(result.stages[2]?.status).toBe('success');
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);  // only post-group
  });

  it('runs parallel group normally when at least one stage is not skipped', async () => {
    vi.mocked(runScript).mockResolvedValue({
      output: { done: true },
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 10,
    });

    const pipeline: PipelineDefinition = {
      name: 'test-parallel-partial-skip',
      description: 'test',
      version: 1,
      stages: [
        {
          group: 'mixed-parallel',
          max_iterations: 1,
          mode: 'parallel',
          stages: [
            {
              name: 'always-runs',
              executor: 'script',
              script: 'scripts/a.py',
              runtime: 'shell',
            },
            {
              name: 'conditional',
              executor: 'script',
              script: 'scripts/b.py',
              runtime: 'shell',
              condition: 'input.enabled >= 1',
            },
          ],
        },
      ],
    };

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: pipeline,
      input: { enabled: 0 },
    });

    expect(result.status).toBe('success');
    expect(result.stages[0]?.status).toBe('success');
    expect(result.stages[1]?.status).toBe('skipped');
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);  // only always-runs
  });
});
```

**Step 2: Run to verify the parallel test fails**

```bash
pnpm --filter @studio-foundation/engine exec vitest run src/__tests__/engine.conditions-group.test.ts
```

Expected: the new parallel all-skipped test fails.

**Step 3: Update parallel path in `GroupOrchestrator.runParallel()`**

In `engine/src/pipeline/group-orchestrator.ts`, in the `runParallel` method, after the `groupStatus` derivation loop (the loop checking `failed`/`cancelled`), add:

```typescript
// If every stage was skipped, the group is skipped (not success)
const allSkipped = group.stages.every(
  (s) => resultMap.get(s.name)?.status === 'skipped',
);
if (allSkipped) groupStatus = 'skipped';
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio-foundation/engine exec vitest run src/__tests__/engine.conditions-group.test.ts
```

Expected: all tests pass.

**Step 5: Run full engine suite**

```bash
pnpm --filter @studio-foundation/engine test
```

Expected: all tests pass.

**Step 6: Commit**

```bash
git add engine/src/pipeline/group-orchestrator.ts engine/src/__tests__/engine.conditions-group.test.ts
git commit -m "feat(engine): handle skipped stages in parallel group orchestration [STU-239]"
```

---

## Task 6: Final build and verification

**Step 1: Build the entire monorepo**

```bash
pnpm build
```

Expected: all 7 packages build without TypeScript errors.

**Step 2: Run all tests**

```bash
pnpm test
```

Expected: all tests across all packages pass.

**Step 3: Verify acceptance criteria manually**

Check each acceptance criterion from STU-239 against the tests:

- [x] `condition: "input.meals_count >= 6"` skips if `meals_count < 6` → `engine.conditions.test.ts` "skips a stage when input condition is false"
- [x] `condition: "stages.entity-extraction.output.counts.OTHER > 0"` skips if 0 or absent → `engine.conditions.test.ts` "skips a stage based on previous stage output"
- [x] Skipped stage has status `skipped` in the run → all integration tests check `status === 'skipped'`
- [x] Stage without `condition` behaves exactly as before → entire existing test suite still passes
- [x] Undefined/absent fields evaluate to false → `condition-evaluator.test.ts` edge cases
- [x] No `eval()` → implementation uses only regex + object traversal
- [x] INV-04 respected: condition is an opaque string, no domain logic in engine

**Step 4: Commit if any cleanup needed, otherwise done**

```bash
pnpm build && pnpm test
```

---

## Summary

| Task | Files | Tests added |
|------|-------|------------|
| 1 | `contracts/src/pipeline.ts` | — |
| 2 | `engine/src/pipeline/condition-evaluator.ts` | `condition-evaluator.test.ts` (15 tests) |
| 3 | `engine/src/pipeline/stage-executor.ts` | `engine.conditions.test.ts` (4 tests) |
| 4 | `engine/src/pipeline/group-orchestrator.ts` | `engine.conditions-group.test.ts` (2 tests) |
| 5 | `engine/src/pipeline/group-orchestrator.ts` | `engine.conditions-group.test.ts` +2 tests |
| 6 | — | Final verification |
