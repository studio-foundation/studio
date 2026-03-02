# Parallel Groups Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `mode: parallel` to `StageGroup` so all stages in a group run concurrently via `Promise.allSettled`, each with its own independent RALPH loop.

**Architecture:** `runGroup` becomes a dispatcher that routes to `runGroupSequential` (current implementation, renamed) or the new `runGroupParallel`. Parallel stages all receive the same pre-group context snapshot and cannot see sibling outputs during execution. After the group completes, all successful outputs are merged into the pipeline context.

**Tech Stack:** TypeScript, Vitest, `Promise.allSettled`, `AbortController`

---

### Task 1: Add `mode` and `on_failure` to `StageGroup` contract type

**Files:**
- Modify: `contracts/src/pipeline.ts`

**Step 1: Add the fields to `StageGroup`**

In `contracts/src/pipeline.ts`, update the `StageGroup` interface:

```typescript
export interface StageGroup {
  group: string;
  max_iterations: number;
  mode?: 'sequential' | 'parallel';         // default: 'sequential'
  on_failure?: 'fail-fast' | 'collect-all'; // parallel only, default: 'fail-fast'
  stages: StageDefinition[];
}
```

**Step 2: Build to verify no type errors**

```bash
cd /path/to/worktree
pnpm build
```
Expected: build passes cleanly.

**Step 3: Commit**

```bash
git add contracts/src/pipeline.ts
git commit -m "feat(contracts): add mode and on_failure fields to StageGroup"
```

---

### Task 2: Parse `mode` and `on_failure` in the pipeline loader

**Files:**
- Modify: `engine/src/pipeline/loader.ts`
- Test: `engine/tests/loader.test.ts`

**Step 1: Write failing tests**

Add this describe block to `engine/tests/loader.test.ts` (after the last existing describe):

```typescript
describe('parsePipelineYaml — parallel group', () => {
  it('parses mode: parallel and on_failure: collect-all', () => {
    const yaml = `
name: parallel-test
description: parallel
version: 1
stages:
  - group: work
    mode: parallel
    on_failure: collect-all
    stages:
      - name: stage-a
        kind: analysis
        agent: analyst
      - name: stage-b
        kind: analysis
        agent: analyst
`;
    const pipeline = parsePipelineYaml(yaml);
    const group = pipeline.stages[0];
    expect(isStageGroup(group)).toBe(true);
    if (isStageGroup(group)) {
      expect(group.mode).toBe('parallel');
      expect(group.on_failure).toBe('collect-all');
    }
  });

  it('defaults mode to sequential when omitted', () => {
    const yaml = `
name: seq-test
description: seq
version: 1
stages:
  - group: work
    stages:
      - name: stage-a
        kind: analysis
        agent: analyst
      - name: stage-b
        kind: analysis
        agent: analyst
`;
    const pipeline = parsePipelineYaml(yaml);
    const group = pipeline.stages[0];
    if (isStageGroup(group)) {
      expect(group.mode).toBeUndefined();
    }
  });

  it('warns and sets max_iterations to 1 when mode is parallel and max_iterations > 1', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const yaml = `
name: parallel-warn-test
description: parallel warn
version: 1
stages:
  - group: work
    mode: parallel
    max_iterations: 3
    stages:
      - name: stage-a
        kind: analysis
        agent: analyst
      - name: stage-b
        kind: analysis
        agent: analyst
`;
    const pipeline = parsePipelineYaml(yaml);
    const group = pipeline.stages[0];
    if (isStageGroup(group)) {
      expect(group.max_iterations).toBe(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("parallel group 'work' has max_iterations > 1")
      );
    }
    consoleSpy.mockRestore();
  });
});
```

Also add `import { vi } from 'vitest';` at the top if not already present.

**Step 2: Run test to confirm it fails**

```bash
cd engine && pnpm test -- --reporter=verbose tests/loader.test.ts 2>&1 | tail -20
```
Expected: 3 failing tests about parallel group parsing.

**Step 3: Implement in loader.ts**

In `engine/src/pipeline/loader.ts`, update the group parsing block (inside the `for (const entry of ...)` loop, `if (entry.group)` branch):

```typescript
if (entry.group) {
  if (!Array.isArray(entry.stages) || entry.stages.length < 2) {
    throw new Error(`Group '${entry.group}' must have at least 2 stages${context}`);
  }
  for (const s of entry.stages) {
    validateStageFields(s, context);
  }

  const mode = entry.mode === 'parallel' ? 'parallel' : undefined;
  let maxIterations: number = entry.max_iterations ?? 3;

  if (mode === 'parallel' && maxIterations > 1) {
    console.warn(
      `[studio] parallel group '${entry.group}' has max_iterations > 1 — iterations are ignored in parallel mode, using 1`
    );
    maxIterations = 1;
  }

  stages.push({
    group: entry.group,
    max_iterations: maxIterations,
    ...(mode ? { mode } : {}),
    ...(entry.on_failure ? { on_failure: entry.on_failure } : {}),
    stages: entry.stages.map((s: any) => ({ ...s, hooks: parseStageHooks(s) })),
  } as StageGroup);
}
```

**Step 4: Run tests to confirm they pass**

```bash
cd engine && pnpm test -- --reporter=verbose tests/loader.test.ts 2>&1 | tail -20
```
Expected: all 3 new tests pass, all existing loader tests still pass.

**Step 5: Commit**

```bash
git add engine/src/pipeline/loader.ts engine/tests/loader.test.ts
git commit -m "feat(engine): parse mode and on_failure in pipeline loader"
```

---

### Task 3: Refactor `runGroup` — rename to `runGroupSequential`, add dispatcher

**Files:**
- Modify: `engine/src/engine.ts`

This is a pure refactor — no behavior change. The existing tests must continue to pass.

**Step 1: Rename `runGroup` to `runGroupSequential`**

In `engine/src/engine.ts`:
1. Rename the method `runGroup` at line 828 to `runGroupSequential`
2. Add a new `runGroup` dispatcher method right before `runGroupSequential`:

```typescript
private async runGroup(
  group: StageGroup,
  context: PipelineContext,
  stageOffset: number,
  totalStages: number,
  userInput: string | Record<string, unknown>,
  paths: ProjectPaths,
  toolRegistry: ToolRegistry,
  runMiddleware?: AnonymizationMiddleware | null,
  runId?: string,
  signal?: AbortSignal,
): Promise<GroupResult> {
  if (group.mode === 'parallel') {
    return this.runGroupParallel(group, context, stageOffset, totalStages, userInput, paths, toolRegistry, runMiddleware, runId, signal);
  }
  return this.runGroupSequential(group, context, stageOffset, totalStages, userInput, paths, toolRegistry, runMiddleware, runId, signal);
}
```

**Step 2: Build and run all engine tests**

```bash
pnpm build && cd engine && pnpm test 2>&1 | tail -15
```
Expected: all existing tests pass (behavior unchanged), build clean.

**Step 3: Commit**

```bash
git add engine/src/engine.ts
git commit -m "refactor(engine): rename runGroup to runGroupSequential, add mode dispatcher"
```

---

### Task 4: Write failing tests for parallel group + create fixtures

**Files:**
- Create: `engine/tests/unit/group-parallel.test.ts`
- (Fixtures created at test setup time via `writeFileSync`)

**Step 1: Create the test file**

Create `engine/tests/unit/group-parallel.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { PipelineEngine } from '../../src/engine.js';
import { InMemoryRunStore } from '../../src/state/run-store.js';
import type { EngineEvents } from '../../src/events.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');
const PROJECT_DIR = join(FIXTURES_DIR, 'test-project');
const PIPELINES_DIR = join(PROJECT_DIR, 'pipelines');
const AGENTS_DIR = join(PROJECT_DIR, 'agents');
const CONTRACTS_DIR = join(PROJECT_DIR, 'contracts');

mkdirSync(PIPELINES_DIR, { recursive: true });
mkdirSync(AGENTS_DIR, { recursive: true });
mkdirSync(CONTRACTS_DIR, { recursive: true });

// Reuse agent fixture from group-loop.test.ts (idempotent writeFileSync)
writeFileSync(join(AGENTS_DIR, 'test-agent.agent.yaml'), `
name: test-agent
provider: anthropic
model: claude-sonnet-4-20250514
temperature: 0.3
`);

// Contract requiring 'result' field
writeFileSync(join(CONTRACTS_DIR, 'basic-result.contract.yaml'), `
name: basic-result
version: 1
schema:
  required_fields:
    - result
`);

// Contract with missing required fields to trigger failure
writeFileSync(join(CONTRACTS_DIR, 'strict-result.contract.yaml'), `
name: strict-result
version: 1
schema:
  required_fields:
    - result
    - must_exist
`);

// Pipeline: 3 stages in parallel, all use basic-result contract
writeFileSync(join(PIPELINES_DIR, 'parallel-test.pipeline.yaml'), `
name: parallel-test
description: Test pipeline with parallel group
version: 1
stages:
  - group: parallel-work
    mode: parallel
    max_iterations: 1
    stages:
      - name: stage-a
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
      - name: stage-b
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
      - name: stage-c
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
`);

// Pipeline: parallel group where stage-b uses strict-result (will fail if wrong output)
writeFileSync(join(PIPELINES_DIR, 'parallel-fail-test.pipeline.yaml'), `
name: parallel-fail-test
description: Test pipeline with a failing stage in parallel group
version: 1
stages:
  - group: parallel-work
    mode: parallel
    on_failure: fail-fast
    stages:
      - name: stage-a
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
      - name: stage-b
        kind: analysis
        agent: test-agent
        contract: strict-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
      - name: stage-c
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
`);

// Pipeline: parallel group with collect-all
writeFileSync(join(PIPELINES_DIR, 'parallel-collect-all-test.pipeline.yaml'), `
name: parallel-collect-all-test
description: Test pipeline with collect-all parallel group
version: 1
stages:
  - group: parallel-work
    mode: parallel
    on_failure: collect-all
    stages:
      - name: stage-a
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
      - name: stage-b
        kind: analysis
        agent: test-agent
        contract: strict-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
      - name: stage-c
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
`);

// Pipeline: parallel group followed by a sequential stage
writeFileSync(join(PIPELINES_DIR, 'parallel-then-sequential-test.pipeline.yaml'), `
name: parallel-then-sequential-test
description: Test pipeline with parallel group followed by sequential stage
version: 1
stages:
  - group: parallel-work
    mode: parallel
    stages:
      - name: stage-a
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
      - name: stage-b
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
  - name: merge-results
    kind: merge
    agent: test-agent
    contract: basic-result
    ralph:
      max_attempts: 1
      retry_strategy: none
    context:
      include:
        - all_stage_outputs
`);

function mockProvider(callFn: (...args: any[]) => any) {
  return {
    name: 'anthropic',
    call: vi.fn(callFn),
  };
}

function createMockToolRegistry() {
  return {
    register: vi.fn(),
    get: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    list: vi.fn().mockReturnValue([]),
    toToolDefinitions: vi.fn().mockReturnValue([]),
    filter: vi.fn().mockReturnThis(),
    getActiveSnippets: vi.fn().mockReturnValue([]),
    clone: vi.fn().mockReturnThis(),
  };
}

function createEngine(provider: any, events?: EngineEvents): PipelineEngine {
  return new PipelineEngine(
    {
      configsDir: PROJECT_DIR,
      providerRegistry: { get: vi.fn().mockReturnValue(provider), register: vi.fn() } as any,
      toolRegistry: createMockToolRegistry() as any,
      db: new InMemoryRunStore(),
    },
    events
  );
}

function successResponse(extra: Record<string, unknown> = {}) {
  return {
    content: JSON.stringify({ result: 'ok', ...extra }),
    tool_calls: [],
    finish_reason: 'stop',
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

function invalidResponse() {
  return {
    content: JSON.stringify({ wrong_field: 'missing result' }),
    tool_calls: [],
    finish_reason: 'stop',
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

describe('Parallel group', () => {
  it('runs all stages concurrently and succeeds when all pass', async () => {
    const provider = mockProvider(() => successResponse());
    const engine = createEngine(provider);

    const result = await engine.run({ pipeline: 'parallel-test', input: 'Test' });

    expect(result.status).toBe('success');
    expect(result.stages).toHaveLength(3);
    expect(result.stages.map(s => s.stage_name)).toEqual(['stage-a', 'stage-b', 'stage-c']);
    expect(provider.call).toHaveBeenCalledTimes(3);
  });

  it('stage runs are ordered by definition order (not execution order)', async () => {
    const provider = mockProvider(() => successResponse());
    const engine = createEngine(provider);

    const result = await engine.run({ pipeline: 'parallel-test', input: 'Test' });

    expect(result.stages[0].stage_name).toBe('stage-a');
    expect(result.stages[1].stage_name).toBe('stage-b');
    expect(result.stages[2].stage_name).toBe('stage-c');
  });

  it('fails group when one stage fails (fail-fast)', async () => {
    // stage-b uses strict-result contract which requires 'must_exist' — mock only returns 'result'
    const provider = mockProvider(() => successResponse());
    const engine = createEngine(provider);

    const result = await engine.run({ pipeline: 'parallel-fail-test', input: 'Test' });

    expect(result.status).toBe('failed');
    // stage-b failed, overall group failed
    const stageBRun = result.stages.find(s => s.stage_name === 'stage-b');
    expect(stageBRun).toBeDefined();
    expect(stageBRun?.status).toBe('failed');
  });

  it('fails group when one stage fails (collect-all), all stages still run', async () => {
    // stage-b uses strict-result — will fail
    const provider = mockProvider(() => successResponse());
    const engine = createEngine(provider);

    const result = await engine.run({ pipeline: 'parallel-collect-all-test', input: 'Test' });

    expect(result.status).toBe('failed');
    // All 3 stages were executed (collect-all doesn't abort)
    expect(provider.call).toHaveBeenCalledTimes(3);
    // The 3 stage runs are all present
    expect(result.stages).toHaveLength(3);
  });

  it('merges successful stage outputs into context after group succeeds', async () => {
    let callCount = 0;
    const provider = mockProvider(() => {
      callCount++;
      return successResponse({ call_number: callCount });
    });
    const engine = createEngine(provider);

    // parallel-then-sequential-test: group (stage-a, stage-b) then merge-results stage
    // merge-results stage uses all_stage_outputs — it will receive stage-a and stage-b outputs
    const result = await engine.run({ pipeline: 'parallel-then-sequential-test', input: 'Test' });

    expect(result.status).toBe('success');
    // 3 calls total: stage-a, stage-b (parallel), then merge-results (sequential)
    expect(provider.call).toHaveBeenCalledTimes(3);
    // Verify merge-results received stage outputs (check via the last provider call's messages)
    const lastCallMessages = (provider.call.mock.calls[2] as any[])[0];
    const userMsg = lastCallMessages.find((m: any) => m.role === 'user');
    expect(userMsg?.content).toContain('stage-a');
    expect(userMsg?.content).toContain('stage-b');
  });

  it('parallel stages cannot see each other outputs (pre-group snapshot only)', async () => {
    // All parallel stages use context include: [all_stage_outputs]
    // They should only see pre-group stage outputs, not sibling outputs
    writeFileSync(join(PIPELINES_DIR, 'parallel-context-isolation-test.pipeline.yaml'), `
name: parallel-context-isolation-test
description: context isolation test
version: 1
stages:
  - name: pre-stage
    kind: analysis
    agent: test-agent
    contract: basic-result
    ralph:
      max_attempts: 1
      retry_strategy: none
    context:
      include:
        - input
  - group: parallel-work
    mode: parallel
    stages:
      - name: stage-a
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - all_stage_outputs
      - name: stage-b
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - all_stage_outputs
`);

    const capturedMessages: Record<string, any[]> = {};
    let callCount = 0;
    const provider = mockProvider((...args: any[]) => {
      callCount++;
      capturedMessages[`call-${callCount}`] = args[0];
      return successResponse({ call_num: callCount });
    });
    const engine = createEngine(provider);

    await engine.run({ pipeline: 'parallel-context-isolation-test', input: 'Test' });

    // calls 2 and 3 are the parallel stages (stage-a and stage-b)
    // They should see 'pre-stage' output but NOT each other's outputs
    const parallelCall1 = capturedMessages['call-2'];
    const parallelCall2 = capturedMessages['call-3'];

    const msg1 = parallelCall1?.find((m: any) => m.role === 'user')?.content ?? '';
    const msg2 = parallelCall2?.find((m: any) => m.role === 'user')?.content ?? '';

    // Both parallel stages should see pre-stage output
    expect(msg1).toContain('pre-stage');
    expect(msg2).toContain('pre-stage');

    // stage-a should NOT see stage-b output, and vice versa
    expect(msg1).not.toContain('stage-b');
    expect(msg2).not.toContain('stage-a');
  });

  it('emits group lifecycle events with iteration=1', async () => {
    const provider = mockProvider(() => successResponse());
    const events: Array<{ type: string; data: any }> = [];

    const engineEvents: EngineEvents = {
      onGroupStart: (e) => events.push({ type: 'start', data: e }),
      onGroupIteration: (e) => events.push({ type: 'iteration', data: e }),
      onGroupFeedback: (e) => events.push({ type: 'feedback', data: e }),
      onGroupComplete: (e) => events.push({ type: 'complete', data: e }),
      onStageStart: () => {},
      onStageComplete: () => {},
      onPipelineStart: () => {},
      onPipelineComplete: () => {},
    };

    const engine = createEngine(provider, engineEvents);
    await engine.run({ pipeline: 'parallel-test', input: 'Test' });

    expect(events.find(e => e.type === 'start')).toBeDefined();
    expect(events.filter(e => e.type === 'iteration')).toHaveLength(1);
    expect(events.find(e => e.type === 'iteration')?.data.iteration).toBe(1);
    expect(events.find(e => e.type === 'feedback')).toBeUndefined(); // no feedback in parallel
    expect(events.find(e => e.type === 'complete')?.data.status).toBe('success');
  });
});
```

**Step 2: Run test to confirm it fails**

```bash
cd engine && pnpm test -- --reporter=verbose tests/unit/group-parallel.test.ts 2>&1 | tail -20
```
Expected: tests fail because `runGroupParallel` doesn't exist yet (the dispatcher calls it but it's not defined, so TypeScript build error or runtime error).

**Step 3: Commit test file**

```bash
git add engine/tests/unit/group-parallel.test.ts
git commit -m "test(engine): add failing tests for parallel group mode"
```

---

### Task 5: Implement `runGroupParallel`

**Files:**
- Modify: `engine/src/engine.ts`

**Step 1: Add `runGroupParallel` method**

Add this method to `PipelineEngine` in `engine/src/engine.ts`, just before `runGroupSequential` (the renamed old `runGroup`). It needs the same imports already present at the top of the file — no new imports needed.

```typescript
private async runGroupParallel(
  group: StageGroup,
  context: PipelineContext,
  stageOffset: number,
  totalStages: number,
  userInput: string | Record<string, unknown>,
  paths: ProjectPaths,
  toolRegistry: ToolRegistry,
  runMiddleware?: AnonymizationMiddleware | null,
  runId?: string,
  signal?: AbortSignal,
): Promise<GroupResult> {
  this.events?.onGroupStart?.({
    group_name: group.group,
    max_iterations: group.max_iterations,
  });
  this.emitter.emit({
    type: 'group_start',
    groupName: group.group,
    maxIterations: group.max_iterations,
  });

  // Parallel groups run exactly one iteration
  this.events?.onGroupIteration?.({
    group_name: group.group,
    iteration: 1,
    max_iterations: group.max_iterations,
  });
  this.emitter.emit({
    type: 'group_iteration',
    groupName: group.group,
    iteration: 1,
    maxIterations: group.max_iterations,
  });

  if (signal?.aborted) {
    this.events?.onGroupComplete?.({ group_name: group.group, iterations: 1, status: 'cancelled' });
    this.emitter.emit({ type: 'group_complete', groupName: group.group, iterations: 1, status: 'cancelled' });
    return { status: 'cancelled', stageRuns: [], stagesExecuted: group.stages.length, context };
  }

  // All parallel stages read the same pre-group context snapshot.
  // previousStageName = the last stage before this group.
  let previousStageName: string | undefined;
  for (const [name] of context.stageOutputs) {
    previousStageName = name;
  }

  // fail-fast: create a shared AbortController to cancel siblings on first failure
  const groupAbort = (group.on_failure ?? 'fail-fast') === 'fail-fast'
    ? new AbortController()
    : null;
  if (groupAbort && signal) {
    signal.addEventListener('abort', () => groupAbort.abort(), { once: true });
  }
  const stageSignal = groupAbort?.signal ?? signal;

  // Launch all stages concurrently
  const settled = await Promise.allSettled(
    group.stages.map(async (stage, i) => {
      const result = await this.executeStage(
        stage,
        context,
        previousStageName,
        userInput,
        stageOffset + i,
        totalStages,
        paths,
        toolRegistry,
        runMiddleware,
        runId,
        stageSignal,
      );
      // fail-fast: abort remaining stages on first non-success
      if (groupAbort && result.status !== 'success') {
        groupAbort.abort();
      }
      return { stageName: stage.name, result };
    }),
  );

  // Build result map keyed by stage name
  const resultMap = new Map<string, StageResult>();
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      resultMap.set(s.value.stageName, s.value.result);
    }
  }

  // Collect stage runs in definition order (deterministic output ordering)
  const allStageRuns: StageRun[] = [];
  for (const stage of group.stages) {
    const result = resultMap.get(stage.name);
    if (result) allStageRuns.push(result.stageRun);
  }

  // Derive group status: cancelled > failed > success
  // rejected treated as failed in parallel mode (no feedback loop)
  let groupStatus: StageStatus = 'success';
  for (const stage of group.stages) {
    const result = resultMap.get(stage.name);
    if (!result) { groupStatus = 'failed'; continue; }
    if (result.status === 'cancelled' && groupStatus === 'success') groupStatus = 'cancelled';
    if (result.status === 'failed' || result.status === 'rejected') groupStatus = 'failed';
  }

  // Merge successful outputs into context in definition order (regardless of group status)
  // This preserves observability for collect-all partial failures
  for (const stage of group.stages) {
    const result = resultMap.get(stage.name);
    if (!result || result.status !== 'success') continue;
    if (result.lastAgentOutput !== undefined) {
      addStageOutput(context, stage.name, result.lastAgentOutput);
    }
    if (result.toolCalls?.length) {
      addStageToolResults(context, stage.name, result.toolCalls);
    }
  }

  this.events?.onGroupComplete?.({ group_name: group.group, iterations: 1, status: groupStatus });
  this.emitter.emit({ type: 'group_complete', groupName: group.group, iterations: 1, status: groupStatus });

  return {
    status: groupStatus,
    stageRuns: allStageRuns,
    stagesExecuted: group.stages.length,
    context,
  };
}
```

**Step 2: Run tests to confirm they pass**

```bash
cd engine && pnpm test -- --reporter=verbose tests/unit/group-parallel.test.ts 2>&1 | tail -25
```
Expected: all parallel group tests pass.

**Step 3: Run all engine tests to verify no regressions**

```bash
cd engine && pnpm test 2>&1 | tail -15
```
Expected: all tests pass (410+ passing, 0 failures).

**Step 4: Commit**

```bash
git add engine/src/engine.ts
git commit -m "feat(engine): implement runGroupParallel with fail-fast and collect-all modes"
```

---

### Task 6: Build everything + final verification

**Step 1: Full build from monorepo root**

```bash
pnpm build 2>&1 | tail -10
```
Expected: all packages build cleanly, no TypeScript errors.

**Step 2: Run all tests**

```bash
pnpm test 2>&1 | tail -20
```
Expected: all tests pass across all packages.

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat(engine): parallel group mode — STU-128

- contracts: add mode and on_failure fields to StageGroup
- loader: parse mode/on_failure, warn on max_iterations > 1 with parallel
- engine: runGroup dispatches to runGroupParallel or runGroupSequential
- engine: runGroupParallel runs all stages via Promise.allSettled
- engine: fail-fast aborts siblings via AbortController on first failure
- engine: collect-all waits for all stages before reporting
- engine: parallel stages receive pre-group context snapshot (no sibling outputs)
- engine: successful outputs merged in definition order after group completes
- tests: 7 new tests covering all parallel group scenarios

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```
