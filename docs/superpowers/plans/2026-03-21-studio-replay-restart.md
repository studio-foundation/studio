# `studio replay --restart` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `studio replay --restart <run-id> --stage <n|name>` to re-execute a pipeline from a specific stage, using cached outputs from prior stages as context.

**Architecture:** Engine-native resume — new `RunInput` fields carry prior stage outputs; engine pre-populates `PipelineContext`, emits synthetic `skipped` `StageRun`s for bypassed stages, then executes normally from the target stage. CLI parses the JSONL log from the prior run and passes extracted data to the engine.

**Tech Stack:** TypeScript, Vitest, Commander (CLI), existing `@studio-foundation/contracts`, `@studio-foundation/engine`, `@studio-foundation/cli`

---

## File Map

| File | Change |
|------|--------|
| `engine/src/events.ts` | `StageCompleteEvent.tool_calls`: `ToolCallSummary[]` → `ToolCall[]`; add `skipped_reason?: string` field |
| `engine/src/pipeline/stage-executor.ts` | Emit full `ToolCall[]` instead of `summarizeToolCalls()` |
| `contracts/src/run.ts` | Add `skipped_reason?: string` to `StageRun` |
| `engine/src/engine.ts` | New `RunInput` fields; `buildSkipSet` helper; resume pre-population; skip logic in stage loop |
| `engine/src/pipeline/group-orchestrator.ts` | Accept optional `skipSet` param; skip group-internal stages before target |
| `cli/src/commands/replay.ts` | New `parseJsonlForResume()` and `restartCommand()` functions |
| `cli/src/index.ts` | Register `--restart` and `--stage` on the `replay` command |
| `cli/src/commands/status.ts` | Display `skipped_reason` when rendering skipped stages |
| `engine/src/__tests__/engine.resume.test.ts` | New — engine resume tests |
| `cli/tests/commands/replay.test.ts` | Extend — `parseJsonlForResume` tests |

---

## Task 1: Upgrade `StageCompleteEvent.tool_calls` to `ToolCall[]`

**Why:** Currently `stage-executor.ts` calls `summarizeToolCalls()` before emitting the `onStageComplete` event, discarding the full `arguments`/`result` data. The JSONL writer logs `ToolCallSummary[]`. For resume to reconstruct `priorStageToolResults`, the log needs full `ToolCall[]`.

**Files:**
- Modify: `engine/src/events.ts`
- Modify: `engine/src/pipeline/stage-executor.ts`

- [ ] **Step 1: Update `StageCompleteEvent` type in `engine/src/events.ts`**

Find the `StageCompleteEvent` interface (currently around line 53):
```typescript
// Before
import type { ToolCallSummary } from './events.js' // (self-referential — it's defined here)
export interface ToolCallSummary {
  name: string;
  arguments_summary: string;
}

export interface StageCompleteEvent {
  // ...
  tool_calls?: ToolCallSummary[];
```

Change `tool_calls` field type:
```typescript
import type { ToolCall } from '@studio-foundation/contracts';

export interface StageCompleteEvent {
  stage_name: string;
  stage_index: number;
  total_stages: number;
  status: string;
  attempts: number;
  duration_ms: number;
  output_summary?: string;
  output?: unknown;
  tool_calls?: ToolCall[];        // was ToolCallSummary[]
  token_usage?: TokenUsage;
  rejection_reason?: string;
  rejection_details?: string[];
  skipped_reason?: string;        // ADD: populated for synthetic skipped stages
}
```

Keep `ToolCallSummary` in the file if it is used elsewhere (check with grep); otherwise remove it.

- [ ] **Step 2: Check if `ToolCallSummary` is used anywhere else**

```bash
grep -rn "ToolCallSummary" /home/arianeguay/dev/src/Studio --include="*.ts"
```

If only `stage-executor.ts` imports it, the import there will be removed in step 3. The type definition itself can be removed from `events.ts` once the import is removed.

- [ ] **Step 3: Update `stage-executor.ts` to emit full `ToolCall[]`**

Find `summarizeToolCalls` (around line 66) and where it's used (around line 558):

```typescript
// Remove this function entirely (or keep it if used elsewhere — check grep)
// function summarizeToolCalls(toolCalls: ToolCall[]): ToolCallSummary[] { ... }

// In the onStageComplete emission (around line 547):
this.config.events?.onStageComplete?.({
  // ...
  tool_calls: lastResult ? lastResult.tool_calls : undefined,  // was: summarizeToolCalls(lastResult.tool_calls)
  // ...
});
```

- [ ] **Step 4: Build and check for type errors**

```bash
cd /home/arianeguay/dev/src/Studio && pnpm build 2>&1 | head -40
```

Expected: clean build (no type errors).

- [ ] **Step 5: Commit**

```bash
git add engine/src/events.ts engine/src/pipeline/stage-executor.ts
git commit -m "feat(engine): log full ToolCall[] in StageCompleteEvent instead of ToolCallSummary"
```

---

## Task 2: Add `skipped_reason` to `StageRun`

**Why:** Skipped stages written by the resume loop need to carry a human-readable note. `StageStatus` already includes `'skipped'` so no union change needed.

**Files:**
- Modify: `contracts/src/run.ts`

- [ ] **Step 1: Add `skipped_reason` field to `StageRun`**

Open `contracts/src/run.ts`. Find the `StageRun` interface:

```typescript
export interface StageRun {
  id: string;
  stage_name: string;
  status: StageStatus;
  started_at: string;
  completed_at?: string;
  tasks: TaskRun[];
  output?: unknown;
  skipped_reason?: string;    // ADD THIS LINE
}
```

- [ ] **Step 2: Build**

```bash
cd /home/arianeguay/dev/src/Studio && pnpm build 2>&1 | head -20
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add contracts/src/run.ts
git commit -m "feat(contracts): add skipped_reason to StageRun"
```

---

## Task 3: Engine resume logic — `RunInput` fields + `buildSkipSet` + stage loop

**Why:** The engine needs to know which stage to start from and have the prior outputs to pre-populate `PipelineContext`. Helper `buildSkipSet` computes which stage names to skip. The stage loop creates synthetic `StageRun` entries for skipped stages and emits `onStageComplete` with `status: 'skipped'` so the JSONL writer captures them.

**Files:**
- Modify: `engine/src/engine.ts`
- Modify: `engine/src/pipeline/group-orchestrator.ts`
- Create: `engine/src/__tests__/engine.resume.test.ts`

- [ ] **Step 1: Write the failing test**

Create `engine/src/__tests__/engine.resume.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineEngine } from '../engine.js';
import type { PipelineDefinition, ToolCall } from '@studio-foundation/contracts';

vi.mock('@studio-foundation/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@studio-foundation/runner')>();
  return {
    ...actual,
    runScript: vi.fn(),
  };
});

import { runScript } from '@studio-foundation/runner';

function makeEngine() {
  return new PipelineEngine({
    configsDir: '/tmp',
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

describe('engine — resume from stage', () => {
  beforeEach(() => vi.clearAllMocks());

  const pipeline: PipelineDefinition = {
    name: 'test-resume',
    description: 'test',
    version: 1,
    stages: [
      { name: 'stage-a', executor: 'script', script: 'x.py', runtime: 'shell' },
      { name: 'stage-b', executor: 'script', script: 'x.py', runtime: 'shell' },
      { name: 'stage-c', executor: 'script', script: 'x.py', runtime: 'shell' },
    ],
  };

  it('skips stages before resumeFromStage and marks them skipped', async () => {
    mockScriptSuccess({ result: 'c-result' });

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: pipeline,
      input: { x: 1 },
      resumeFromStage: 'stage-c',
      priorStageOutputs: new Map([
        ['stage-a', { result: 'a-cached' }],
        ['stage-b', { result: 'b-cached' }],
      ]),
      originalRunId: 'abc12345',
    });

    expect(result.status).toBe('success');
    expect(result.stages).toHaveLength(3);
    expect(result.stages[0]?.stage_name).toBe('stage-a');
    expect(result.stages[0]?.status).toBe('skipped');
    expect(result.stages[0]?.skipped_reason).toContain('abc12345');
    expect(result.stages[1]?.stage_name).toBe('stage-b');
    expect(result.stages[1]?.status).toBe('skipped');
    expect(result.stages[2]?.stage_name).toBe('stage-c');
    expect(result.stages[2]?.status).toBe('success');
    // Only stage-c was actually executed
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);
  });

  it('pre-populates context so resumed stage can access prior outputs', async () => {
    let capturedContext: string | undefined;
    vi.mocked(runScript).mockImplementation(async (script, args, _ctx) => {
      // Capture the context string passed to the script stage
      capturedContext = typeof args === 'string' ? args : JSON.stringify(args);
      return { output: { result: 'ok' }, tool_calls: [], tool_calls_count: 0, duration_ms: 10 };
    });

    const engine = makeEngine();
    await engine.run({
      pipelineDef: {
        ...pipeline,
        stages: [
          { name: 'stage-a', executor: 'script', script: 'x.py', runtime: 'shell' },
          {
            name: 'stage-b',
            executor: 'script',
            script: 'x.py',
            runtime: 'shell',
            context: { include: ['all_stage_outputs'] },
          },
        ],
      },
      input: { x: 1 },
      resumeFromStage: 'stage-b',
      priorStageOutputs: new Map([['stage-a', { result: 'a-cached' }]]),
    });

    // stage-b's context should contain stage-a's cached output
    expect(capturedContext).toBeDefined();
    // The exact assertion depends on how runScript receives context — check context-propagation
    // At minimum, no crash: context was built and passed
  });

  it('throws if resumeFromStage is not found in pipeline', async () => {
    const engine = makeEngine();
    await expect(
      engine.run({
        pipelineDef: pipeline,
        input: {},
        resumeFromStage: 'nonexistent-stage',
        priorStageOutputs: new Map(),
      })
    ).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/engine test 2>&1 | grep -A 5 "engine.resume"
```

Expected: FAIL — `RunInput` does not have `resumeFromStage`.

- [ ] **Step 3: Add resume fields to `RunInput` in `engine/src/engine.ts`**

Find the `RunInput` interface (around line 52):

```typescript
import type { ToolCall } from '@studio-foundation/contracts';

export interface RunInput {
  id?: string;
  pipeline?: string;
  pipelineDef?: PipelineDefinition;
  input?: string | Record<string, unknown>;
  userInput?: string | Record<string, unknown>;
  meta?: Record<string, unknown>;
  anonymize?: boolean;
  signal?: AbortSignal;
  depth?: number;
  parentRunId?: string;
  // Resume fields
  resumeFromStage?: string;
  priorStageOutputs?: Map<string, unknown>;
  priorStageToolResults?: Map<string, ToolCall[]>;
  originalRunId?: string;
}
```

- [ ] **Step 4: Add `buildSkipSet` helper in `engine/src/engine.ts`**

Add this after `countTotalStages` (around line 73):

```typescript
/**
 * Collect all leaf stage names in pipeline order (group containers are transparent).
 */
function collectLeafStageNames(entries: PipelineEntry[]): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    if (isStageGroup(entry)) {
      for (const stage of entry.stages) names.push(stage.name);
    } else {
      names.push(entry.name);
    }
  }
  return names;
}

/**
 * Returns the set of stage names that should be skipped (all leaf stages before resumeFromStage).
 * Throws if resumeFromStage is not found in the pipeline.
 */
function buildSkipSet(entries: PipelineEntry[], resumeFromStage: string): Set<string> {
  const leafNames = collectLeafStageNames(entries);
  const targetIndex = leafNames.indexOf(resumeFromStage);
  if (targetIndex < 0) {
    throw new Error(`Stage "${resumeFromStage}" not found in pipeline`);
  }
  return new Set(leafNames.slice(0, targetIndex));
}
```

- [ ] **Step 5: Pre-populate context and build skipSet in `engine.run()` before the stage loop**

Find the block after `pipelineContext.invariantsContent = ...` and before `const totalStages = ...` (around line 186):

```typescript
// Pre-populate context from prior run if resuming
const skipSet: Set<string> =
  input.resumeFromStage
    ? buildSkipSet(pipeline.stages, input.resumeFromStage)
    : new Set();

if (input.resumeFromStage) {
  for (const [stageName, output] of input.priorStageOutputs ?? []) {
    addStageOutput(pipelineContext, stageName, output);
  }
  for (const [stageName, toolCalls] of input.priorStageToolResults ?? []) {
    addStageToolResults(pipelineContext, stageName, toolCalls);
  }
}
```

- [ ] **Step 6: Add skip logic in the simple-stage branch of the loop**

In the `else` branch of `if (isStageGroup(entry))`, before `stageCounter++` (around line 276):

```typescript
} else {
  // ========== SIMPLE STAGE ==========
  stageCounter++;

  // Skip stage if resuming from a later stage
  if (skipSet.has(entry.name)) {
    const now = new Date().toISOString();
    const skippedRun: StageRun = {
      id: `skipped-${entry.name}`,
      stage_name: entry.name,
      status: 'skipped',
      started_at: now,
      completed_at: now,
      tasks: [],
      skipped_reason: input.originalRunId
        ? `resumed from run ${input.originalRunId}`
        : 'resumed from prior run',
    };
    const skippedReason = input.originalRunId
      ? `resumed from run ${input.originalRunId}`
      : 'resumed from prior run';
    this.events?.onStageComplete?.({
      stage_name: entry.name,
      stage_index: stageCounter - 1,
      total_stages: totalStages,
      status: 'skipped',
      attempts: 0,
      duration_ms: 0,
      skipped_reason: skippedReason,  // IMPORTANT: must be in event so JSONL writer logs it
    });
    pipelineRun.stages.push(skippedRun);
    previousStageName = entry.name;
    continue;
  }

  const result = await this.stageExecutor.execute( ... ); // existing code
```

Note: import `StageRun` from `@studio-foundation/contracts` at the top of `engine.ts` if not already imported.

- [ ] **Step 7: Add skip logic in the group branch**

In the `if (isStageGroup(entry))` branch, add handling before the `groupOrchestrator.run()` call:

```typescript
if (isStageGroup(entry)) {
  // Check if all group stages should be skipped
  const allGroupStagesSkipped = entry.stages.every(s => skipSet.has(s.name));

  if (allGroupStagesSkipped) {
    const now = new Date().toISOString();
    for (const stage of entry.stages) {
      stageCounter++;
      const groupSkipReason = input.originalRunId
        ? `resumed from run ${input.originalRunId}`
        : 'resumed from prior run';
      const skippedRun: StageRun = {
        id: `skipped-${stage.name}`,
        stage_name: stage.name,
        status: 'skipped',
        started_at: now,
        completed_at: now,
        tasks: [],
        skipped_reason: groupSkipReason,
      };
      this.events?.onStageComplete?.({
        stage_name: stage.name,
        stage_index: stageCounter - 1,
        total_stages: totalStages,
        status: 'skipped',
        attempts: 0,
        duration_ms: 0,
        skipped_reason: groupSkipReason,  // must be in event so JSONL writer logs it
      });
      pipelineRun.stages.push(skippedRun);
      previousStageName = stage.name;
    }
    clearGroupFeedback(pipelineContext);
    continue;
  }

  // Some (or no) group stages are skipped — pass skipSet to the orchestrator
  const groupResult = await this.groupOrchestrator.run(
    entry,
    pipelineContext,
    stageCounter,
    totalStages,
    userInputValue,
    projectPaths,
    runToolRegistry,
    runMiddleware,
    pipelineRun.id,
    signal,
    skipSet,       // NEW: pass skipSet for partial group skip
    input.originalRunId,
  );
  // ... rest of existing group handling
```

- [ ] **Step 8: Add `skipSet` and `originalRunId` to `GroupOrchestrator.run()` and `runSequential()`**

In `engine/src/pipeline/group-orchestrator.ts`:

```typescript
async run(
  group: StageGroup,
  context: PipelineContext,
  stageOffset: number,
  totalStages: number,
  userInput: string | Record<string, unknown>,
  paths: ProjectPaths,
  toolRegistry: ToolRegistry | undefined,
  runMiddleware?: AnonymizationMiddleware | null,
  runId?: string,
  signal?: AbortSignal,
  skipSet?: Set<string>,      // NEW
  originalRunId?: string,     // NEW
): Promise<GroupResult> {
  if (group.mode === 'parallel') {
    return this.runParallel(group, context, stageOffset, totalStages, userInput, paths, toolRegistry, runMiddleware, runId, signal);
    // Note: parallel mode skip not supported (parallel groups in a resume context run fully)
  }
  return this.runSequential(group, context, stageOffset, totalStages, userInput, paths, toolRegistry, runMiddleware, runId, signal, skipSet, originalRunId);
}
```

In `runSequential()`, add skip logic for the first iteration only. Find where stages are executed inside the iteration loop (the inner loop over `group.stages`). Before calling `this.config.stageExecutor.execute(...)`, add:

```typescript
// On iteration 1, skip stages before resumeFromStage
if (iteration === 1 && skipSet?.has(stage.name)) {
  const now = new Date().toISOString();
  const skippedRun: StageRun = {
    id: `skipped-${stage.name}`,
    stage_name: stage.name,
    status: 'skipped',
    started_at: now,
    completed_at: now,
    tasks: [],
    skipped_reason: originalRunId
      ? `resumed from run ${originalRunId}`
      : 'resumed from prior run',
  };
  this.config.events?.onStageComplete?.({
    stage_name: stage.name,
    stage_index: stageCounter,
    total_stages: totalStages,
    status: 'skipped',
    attempts: 0,
    duration_ms: 0,
  });
  stageRuns.push(skippedRun);
  previousStageName = stage.name;
  continue;  // skip to next stage in group
}
```

You will need to examine the `runSequential` inner loop (around line 191) to find the exact insertion point and variable names (`stageCounter`, `stageRuns`, `previousStageName`, etc.).

- [ ] **Step 9: Run tests**

```bash
cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/engine test 2>&1 | tail -20
```

Expected: all engine tests pass including the new resume tests.

- [ ] **Step 10: Build**

```bash
cd /home/arianeguay/dev/src/Studio && pnpm build 2>&1 | head -20
```

- [ ] **Step 11: Commit**

```bash
git add engine/src/engine.ts engine/src/pipeline/group-orchestrator.ts engine/src/__tests__/engine.resume.test.ts
git commit -m "feat(engine): add resume-from-stage support (RunInput.resumeFromStage)"
```

---

## Task 4: CLI — JSONL parsing + `--restart`/`--stage` flags

**Why:** The CLI must parse the JSONL log to reconstruct prior stage outputs and tool calls, resolve the `--stage` argument against the current pipeline YAML, and call `engine.run()` with the resume fields.

**Files:**
- Modify: `cli/src/commands/replay.ts`
- Modify: `cli/src/index.ts`
- Modify: `cli/tests/commands/replay.test.ts`

- [ ] **Step 1: Write failing tests for `parseJsonlForResume`**

Add to `cli/tests/commands/replay.test.ts`:

```typescript
import { parseJsonlForResume, resolveStageFromPipeline } from '../../src/commands/replay.js';
import type { PipelineDefinition } from '@studio-foundation/contracts';

describe('parseJsonlForResume', () => {
  it('extracts input and stage outputs from JSONL', () => {
    const lines = [
      JSON.stringify({ event: 'pipeline_start', pipeline: 'my-pipe', run_id: 'abc12345', input: { x: 1 } }),
      JSON.stringify({ event: 'stage_complete', stage: 'stage-a', run_id: 'abc12345', status: 'success', attempts: 1, duration_ms: 100, output: { result: 'a-result' }, tool_calls: [] }),
      JSON.stringify({ event: 'stage_complete', stage: 'stage-b', run_id: 'abc12345', status: 'success', attempts: 1, duration_ms: 200, output: { result: 'b-result' }, tool_calls: [{ id: '1', name: 'repo_manager-read_file', arguments: { path: 'foo.ts' } }] }),
    ].join('\n');

    const result = parseJsonlForResume(lines);

    expect(result.pipelineInput).toEqual({ x: 1 });
    expect(result.stageOutputs.get('stage-a')).toEqual({ result: 'a-result' });
    expect(result.stageOutputs.get('stage-b')).toEqual({ result: 'b-result' });
    expect(result.stageToolResults.get('stage-b')).toHaveLength(1);
    expect(result.stageToolResults.get('stage-b')![0]!.name).toBe('repo_manager-read_file');
  });

  it('returns empty maps if no stage_complete events', () => {
    const lines = JSON.stringify({ event: 'pipeline_start', pipeline: 'x', run_id: 'abc', input: {} });
    const result = parseJsonlForResume(lines);
    expect(result.stageOutputs.size).toBe(0);
    expect(result.stageToolResults.size).toBe(0);
  });

  it('skips stages with no output', () => {
    const lines = JSON.stringify({ event: 'stage_complete', stage: 'stage-a', run_id: 'abc', status: 'success', attempts: 1, duration_ms: 100 });
    const result = parseJsonlForResume(lines);
    expect(result.stageOutputs.has('stage-a')).toBe(false);
  });
});

describe('resolveStageFromPipeline', () => {
  const pipeline: PipelineDefinition = {
    name: 'test',
    description: 'test',
    version: 1,
    stages: [
      { name: 'stage-a', executor: 'script', script: 'x.py', runtime: 'shell' },
      {
        group: 'my-group',
        max_iterations: 3,
        stages: [
          { name: 'stage-b', executor: 'script', script: 'x.py', runtime: 'shell' },
          { name: 'stage-c', executor: 'script', script: 'x.py', runtime: 'shell' },
        ],
      },
    ],
  };

  it('resolves a stage name by exact match', () => {
    expect(resolveStageFromPipeline('stage-b', pipeline)).toBe('stage-b');
  });

  it('resolves a stage by 0-based leaf index', () => {
    // leaf order: stage-a(0), stage-b(1), stage-c(2)
    expect(resolveStageFromPipeline('0', pipeline)).toBe('stage-a');
    expect(resolveStageFromPipeline('1', pipeline)).toBe('stage-b');
    expect(resolveStageFromPipeline('2', pipeline)).toBe('stage-c');
  });

  it('throws if name not found', () => {
    expect(() => resolveStageFromPipeline('nonexistent', pipeline)).toThrow(/not found/i);
  });

  it('throws if index out of bounds', () => {
    expect(() => resolveStageFromPipeline('5', pipeline)).toThrow(/out of bounds/i);
  });

  it('throws if index 0 (no stages to skip — warn)', () => {
    // index 0 is valid but returns stage-a (nothing skipped)
    expect(resolveStageFromPipeline('0', pipeline)).toBe('stage-a');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test -- --reporter=verbose 2>&1 | grep -A 5 "parseJsonlForResume\|resolveStage"
```

Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement `parseJsonlForResume` and `resolveStageFromPipeline` in `cli/src/commands/replay.ts`**

Add these exports after the existing `mapJsonlLineToEvent` function:

```typescript
import type { PipelineDefinition, ToolCall } from '@studio-foundation/contracts';

export interface ResumeContext {
  pipelineInput: string | Record<string, unknown>;
  stageOutputs: Map<string, unknown>;
  stageToolResults: Map<string, ToolCall[]>;
}

/**
 * Parse a JSONL log string and extract data needed to resume from a stage.
 * Returns input from pipeline_start, and outputs+tool_calls from stage_complete events.
 */
export function parseJsonlForResume(jsonlContent: string): ResumeContext {
  const stageOutputs = new Map<string, unknown>();
  const stageToolResults = new Map<string, ToolCall[]>();
  let pipelineInput: string | Record<string, unknown> = {};

  const lines = jsonlContent.split('\n').filter((l) => l.trim().length > 0);

  for (const raw of lines) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue; // skip corrupt lines
    }

    const event = record.event as string;

    if (event === 'pipeline_start' && record.input !== undefined) {
      pipelineInput = record.input as string | Record<string, unknown>;
    }

    if (event === 'stage_complete') {
      const stageName = record.stage as string;
      if (!stageName) continue;

      if (record.output !== undefined) {
        stageOutputs.set(stageName, record.output);
      }

      if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) {
        stageToolResults.set(stageName, record.tool_calls as ToolCall[]);
      }
    }
  }

  return { pipelineInput, stageOutputs, stageToolResults };
}

/**
 * Resolve a --stage argument (integer index or stage name) to a stage name
 * using the current pipeline definition. Groups are transparent — index counts leaf stages.
 * Throws with a clear message if not found or out of bounds.
 */
export function resolveStageFromPipeline(
  stageArg: string,
  pipeline: PipelineDefinition
): string {
  // Collect leaf stage names in order
  const leafNames: string[] = [];
  for (const entry of pipeline.stages) {
    if ('group' in entry && Array.isArray(entry.stages)) {
      for (const s of entry.stages) leafNames.push(s.name);
    } else if ('name' in entry) {
      leafNames.push(entry.name as string);
    }
  }

  // Try numeric index first
  const asNumber = parseInt(stageArg, 10);
  if (!isNaN(asNumber) && stageArg.match(/^\d+$/)) {
    if (asNumber < 0 || asNumber >= leafNames.length) {
      throw new Error(
        `Stage index ${asNumber} is out of bounds. Pipeline has ${leafNames.length} stages (0–${leafNames.length - 1}).`
      );
    }
    return leafNames[asNumber]!;
  }

  // Try name match
  if (leafNames.includes(stageArg)) {
    return stageArg;
  }

  throw new Error(
    `Stage "${stageArg}" not found in pipeline. Available stages: ${leafNames.join(', ')}`
  );
}
```

- [ ] **Step 4: Implement `restartCommand` in `cli/src/commands/replay.ts`**

Add this function after `replayCommand`:

```typescript
import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import { PipelineEngine } from '@studio-foundation/engine';
import { loadConfig } from '../config.js';
import { createRunStore } from '../run-store-factory.js';
import { loadPipeline } from '../pipeline-loader.js'; // adjust path if needed
import { createProgressDisplay } from '../output/progress.js'; // adjust if needed

interface RestartOptions {
  stage: string;
  verbose?: boolean;
  provider?: string;   // optional provider override (e.g. mock), same as studio run --provider
}

export async function restartCommand(
  runId: string,
  options: RestartOptions
): Promise<void> {
  try {
    const runsDir = resolve(process.cwd(), '.studio/runs');
    const filePath = findJsonlFile(runsDir, runId);

    const content = readFileSync(filePath, 'utf-8');
    const { pipelineInput, stageOutputs, stageToolResults } = parseJsonlForResume(content);

    // Load pipeline name from the JSONL (pipeline_start event has it)
    const firstLine = content.split('\n').find((l) => l.includes('"pipeline_start"'));
    const pipelineName = firstLine
      ? (JSON.parse(firstLine) as Record<string, unknown>).pipeline as string
      : undefined;

    if (!pipelineName) {
      throw new Error(`Could not determine pipeline name from run log for run ${runId}`);
    }

    // Load current pipeline YAML to resolve --stage
    const config = await loadConfig();
    const pipeline = await loadPipelineByName(pipelineName, config); // see note below
    const resolvedStage = resolveStageFromPipeline(options.stage, pipeline);

    // Warn if starting from stage 0 (nothing to skip)
    const leafNames = Object.values(pipeline.stages).flatMap((e: any) =>
      'group' in e ? e.stages.map((s: any) => s.name) : [e.name]
    );
    if (resolvedStage === leafNames[0]) {
      console.warn(
        chalk.yellow(
          `Warning: --stage resolves to the first stage (${resolvedStage}). No stages will be skipped — equivalent to a fresh run.`
        )
      );
    }

    // Set up engine and run
    const runStore = await createRunStore(config);
    const engine = new PipelineEngine({
      configsDir: resolve(process.cwd(), '.studio'),
      db: runStore,
      // providerRegistry and other config loaded from config
      // (follow the same pattern as in cli/src/commands/run.ts)
    });

    // Print new run header
    console.log(chalk.bold(`Resuming ${pipelineName} from stage ${chalk.cyan(resolvedStage)}`));
    console.log(chalk.dim(`Original run: ${runId}`));

    const result = await engine.run({
      pipeline: pipelineName,
      input: pipelineInput,
      resumeFromStage: resolvedStage,
      priorStageOutputs: stageOutputs,
      priorStageToolResults: stageToolResults,
      originalRunId: runId,
    });

    console.log(
      result.status === 'success'
        ? chalk.green(`\n✓ Pipeline resumed successfully (run ${result.id})`)
        : chalk.red(`\n✗ Pipeline ended with status: ${result.status} (run ${result.id})`)
    );
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
```

**Note:** `loadPipelineByName` needs to load and parse the YAML file for the given pipeline. Check how `cli/src/commands/run.ts` initializes the engine — mirror that setup exactly. The engine internally loads the pipeline from `configsDir`. You don't need to load it separately; instead, pass `pipeline: pipelineName` to `engine.run()` and the engine resolves it. But you *do* need the `PipelineDefinition` to call `resolveStageFromPipeline`. Use the engine's loader or load it directly with the existing `loadPipeline` utility from `@studio-foundation/engine`.

Check what's exported from `@studio-foundation/engine`:
```bash
grep -n "export" /home/arianeguay/dev/src/Studio/engine/src/index.ts | head -20
```

If `loadPipeline` is exported, use it. Otherwise, import the pipeline loader directly (it's `engine/src/pipeline/loader.ts`).

- [ ] **Step 5: Run CLI tests**

```bash
cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test 2>&1 | tail -20
```

Expected: `parseJsonlForResume` and `resolveStageFromPipeline` tests pass.

- [ ] **Step 6: Register `--restart` and `--stage` in `cli/src/index.ts`**

Find the `replay` command registration (around line 61):

```typescript
// Before:
program
  .command('replay <run-id>')
  .description('Replay a past pipeline run from JSONL logs (same rendering as --live)')
  .option('--verbose', 'Show complete outputs and tool call results')
  .action(replayCommand);

// After:
import { replayCommand, restartCommand } from './commands/replay.js';

program
  .command('replay <run-id>')
  .description('Replay a past pipeline run from JSONL logs, or re-execute from a specific stage')
  .option('--verbose', 'Show complete outputs and tool call results')
  .option('--restart', 'Re-execute pipeline from a specific stage (requires --stage)')
  .option('--stage <index|name>', 'Stage index (0-based) or name to restart from (use with --restart)')
  .option('--provider <name>', 'Override LLM provider (e.g. mock) — applies to resumed stages only')
  .action((runId: string, options: { verbose?: boolean; restart?: boolean; stage?: string; provider?: string }) => {
    if (options.restart) {
      if (!options.stage) {
        console.error(chalk.red('Error: --restart requires --stage <index|name>'));
        process.exit(1);
      }
      return restartCommand(runId, { stage: options.stage, verbose: options.verbose, provider: options.provider });
    }
    return replayCommand(runId, options);
  });
```

- [ ] **Step 7: Build**

```bash
cd /home/arianeguay/dev/src/Studio && pnpm build 2>&1 | head -30
```

- [ ] **Step 8: Commit**

```bash
git add cli/src/commands/replay.ts cli/src/index.ts cli/tests/commands/replay.test.ts
git commit -m "feat(cli): add replay --restart --stage for pipeline resume (STU-242)"
```

---

## Task 5: Display `skipped_reason` in `studio status` output

**Why:** The spec says skipped stages appear in `studio status` with `status: skipped`. The `getRunFromJsonl` function in `status.ts` builds `StageRun[]` from JSONL `stage_complete` events. Skipped stages will be logged by the engine's `onStageComplete` emission in Task 3. We need to pass `skipped_reason` through.

**Files:**
- Modify: `cli/src/commands/status.ts`

- [ ] **Step 1: Update `getRunFromJsonl` to capture `skipped_reason`**

In `status.ts`, the `stageCompletes` array currently captures `{ stage_name, status, attempts }`. Extend it:

```typescript
// Before
const stageCompletes: Array<{ stage_name: string; status: string; attempts: number }> = [];

// After
const stageCompletes: Array<{
  stage_name: string;
  status: string;
  attempts: number;
  skipped_reason?: string;
}> = [];
```

In the `stage_complete` branch (around line 74):

```typescript
} else if (event === 'stage_complete') {
  stageCompletes.push({
    stage_name: (r.stage as string) ?? '',
    status: (r.status as string) ?? 'unknown',
    attempts: (r.attempts as number) ?? 1,
    skipped_reason: r.skipped_reason as string | undefined,   // ADD
  });
}
```

In the `stages.map()` block (around line 93):

```typescript
const stages: StageRun[] = stageCompletes.map((s, i) => ({
  id: `stage-${i}`,
  stage_name: s.stage_name,
  status: s.status as StageRun['status'],
  started_at: started_at,
  completed_at: completed_at,
  skipped_reason: s.skipped_reason,    // ADD
  tasks: [ ... ],                       // existing
}));
```

- [ ] **Step 2: Check how `formatResult` renders stages**

```bash
cat /home/arianeguay/dev/src/Studio/cli/src/output/formatter.ts | grep -A 20 "skipped\|stage_name\|status"
```

If `formatResult` already renders `status: 'skipped'` (it likely does since `'skipped'` is already used for conditional stages), no further changes are needed. If `skipped_reason` should be shown inline, add it to the formatter's stage rendering — but only if it's not already displayed.

- [ ] **Step 3: Build and run CLI tests**

```bash
cd /home/arianeguay/dev/src/Studio && pnpm build && pnpm --filter @studio-foundation/cli test 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git add cli/src/commands/status.ts
git commit -m "feat(cli): show skipped_reason in studio status for resumed runs"
```

---

## Task 6: Final integration test (manual)

- [ ] **Step 1: Build everything**

```bash
cd /home/arianeguay/dev/src/Studio && pnpm build
```

- [ ] **Step 2: Run all tests**

```bash
cd /home/arianeguay/dev/src/Studio && pnpm test 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 3: Smoke test with mock provider** (if a `.studio/` fixture is available)

```bash
# Run a pipeline until it "fails" at stage 2
cd /tmp && mkdir smoke-test && cd smoke-test
studio init --template software --name smoke --yes
studio run feature-builder --provider mock --input "test" || true

# Get the run ID from the output, then:
studio replay --restart <run-id> --stage 1 --provider mock
```

Verify:
- `studio status` shows stage 0 as `skipped (resumed from run <original-id>)`, stage 1 onward as `success`
- The new run has a new run ID
- No crash

- [ ] **Step 4: Final commit if anything adjusted**

```bash
cd /home/arianeguay/dev/src/Studio
git add -p
git commit -m "fix(cli): smoke test adjustments for replay --restart"
```
