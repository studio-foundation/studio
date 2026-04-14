# STU-25 — Cancel Run: Graceful Shutdown Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the four gaps in the already-implemented cancellation feature: fix the SSE double-close bug, add `DELETE /api/runs/:id`, make the state machine handle `'cancel'` transitions, and add missing engine tests.

**Architecture:** Most of STU-25 was completed as part of STU-131 (PR #103). The `AbortSignal`/`AbortController` pattern is used throughout — `ralph` loop, engine stage loop, and runner all check the signal. This plan patches the remaining gaps without restructuring anything.

**Tech Stack:** TypeScript, Vitest, Fastify, AbortSignal (Web API)

**Branch:** `arianedguay/stu-25-phase-4-cancel-run-graceful-shutdown`

---

## Setup: Create worktree

Per CLAUDE.md: Linear ticket = worktree first.

```bash
# From the Studio repo root
git worktree add .worktrees/stu-25-cancel -b arianedguay/stu-25-phase-4-cancel-run-graceful-shutdown
cd .worktrees/stu-25-cancel
```

Then run all tasks from inside the worktree.

---

## Task 1: State Machine 'cancel' Transition

Cancellation currently bypasses `transition()` in engine by directly assigning `stageRun.status = 'cancelled'`. Adding `'cancel'` to the state machine makes the pattern consistent with all other transitions.

**Files:**
- Modify: `engine/src/state/state-machine.ts`
- Modify (tests): `engine/tests/state-machine.test.ts`
- Modify (engine): `engine/src/engine.ts`

### Step 1: Write the failing test

Add to the `describe('transition')` block in `engine/tests/state-machine.test.ts`:

```typescript
it('running + cancel → cancelled', () => {
  expect(transition('running', 'cancel')).toBe('cancelled');
});

it('pending + cancel throws', () => {
  expect(() => transition('pending', 'cancel')).toThrow('Invalid state transition');
});

it('running → cancelled is valid transition', () => {
  expect(isValidTransition('running', 'cancelled')).toBe(true);
});
```

### Step 2: Run to verify failure

```bash
pnpm --filter @studio-foundation/engine test 2>&1 | grep -E "cancel|FAIL|✗"
```

Expected: test fails with "Invalid state transition: running + cancel"

### Step 3: Add the transition to state-machine.ts

In `engine/src/state/state-machine.ts`, make these two changes:

```typescript
// Change StageEvent type — add 'cancel':
type StageEvent = 'start' | 'succeed' | 'fail' | 'skip' | 'reject' | 'cancel';

// Add to VALID_TRANSITIONS map:
const VALID_TRANSITIONS: Record<string, StageLifecycleState> = {
  'pending:start': 'running',
  'running:succeed': 'success',
  'running:fail': 'failed',
  'pending:skip': 'skipped',
  'running:reject': 'rejected',
  'running:cancel': 'cancelled',   // ← ADD THIS
};
```

### Step 4: Run to verify state-machine tests pass

```bash
pnpm --filter @studio-foundation/engine test 2>&1 | grep -E "cancel|PASS|✓"
```

Expected: all 3 new tests pass

### Step 5: Update engine.ts to use transition() for cancellation

In `engine/src/engine.ts`, find and replace the 3 spots where `stageRun.status = 'cancelled'` is set directly. All 3 are inside `executeStage()` at the part that handles the cancelled stageStatus after `deriveStageStatus()`.

Search for this pattern (around line 754):
```typescript
if (stageStatus === 'cancelled') {
  stageRun.status = 'cancelled';
```

Replace with (in all 3 occurrences inside `executeStage`):
```typescript
if (stageStatus === 'cancelled') {
  stageRun.status = transition('running', 'cancel');
```

Also add the import at the top of `engine.ts` if `transition` is not already imported:
```typescript
import { deriveStageStatus } from './state/status-derivation.js';
import { transition } from './state/state-machine.js';   // add if missing
```

**Note:** There is currently only 1 spot in `executeStage` (line ~754). Check with grep:
```bash
grep -n "stageRun.status = 'cancelled'" engine/src/engine.ts
```

### Step 6: Verify all engine tests still pass

```bash
pnpm --filter @studio-foundation/engine test
```

Expected: all tests pass (no regressions)

### Step 7: Commit

```bash
git add engine/src/state/state-machine.ts engine/src/engine.ts engine/tests/state-machine.test.ts
git commit -m "feat(engine): add 'cancel' transition to state machine"
```

---

## Task 2: Missing Engine Cancellation Tests

Three new integration tests for the engine covering the important mid-run cancellation cases. These validate existing code — some may already pass; if they don't, investigate why before moving on.

**Files:**
- Modify: `engine/tests/unit/engine.test.ts`

### Step 1: Add group pipeline fixture to setupTestFixtures()

Inside `setupTestFixtures()` in `engine/tests/unit/engine.test.ts`, add a group pipeline fixture after the existing fixtures:

```typescript
writeFileSync(join(PIPELINES_DIR, 'group-simple.pipeline.yaml'), `
name: group-simple
description: Pipeline with a simple group for cancellation testing
version: 1
stages:
  - group: review-loop
    max_iterations: 2
    stages:
      - name: review-stage-1
        agent: test-agent
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
      - name: review-stage-2
        agent: test-agent
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
`);
```

### Step 2: Write Test A — mid-run cancellation

Add to `engine/tests/unit/engine.test.ts` (inside the existing describe block):

```typescript
it('cancels cleanly when signal is aborted while a stage is executing', async () => {
  const controller = new AbortController();

  // Make the provider slow (100ms) so the signal can fire mid-execution
  const slowProvider = {
    name: 'anthropic',
    call: vi.fn().mockImplementation(
      () => new Promise((resolve) =>
        setTimeout(() => resolve({
          content: JSON.stringify({ summary: 'done', requirements: [], acceptance_criteria: [] }),
          tool_calls: [],
          finish_reason: 'stop',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }), 100)
      )
    ),
  };

  const engine = createTestEngine({
    providerRegistry: { get: vi.fn().mockReturnValue(slowProvider), register: vi.fn() } as any,
  });

  // Abort after 10ms (before the 100ms provider resolves)
  setTimeout(() => controller.abort(), 10);

  const result = await engine.run({
    pipeline: 'simple',
    input: 'test input',
    signal: controller.signal,
  });

  expect(result.status).toBe('cancelled');
});
```

### Step 3: Write Test B — signal aborted between stages

```typescript
it('cancels between stages when signal is aborted after first stage completes', async () => {
  const controller = new AbortController();
  let stage1Completed = false;

  const events: EngineEvents = {
    onStageComplete: (e) => {
      if (e.stage_name === 'stage-1') {
        stage1Completed = true;
        controller.abort(); // abort after stage 1 finishes
      }
    },
  };

  const engine = new PipelineEngine(
    {
      configsDir: PROJECT_DIR,
      providerRegistry: createMockProviderRegistry() as any,
      toolRegistry: createMockToolRegistry() as any,
      db: new InMemoryRunStore(),
    },
    events
  );

  const result = await engine.run({
    pipeline: 'two-stage',
    input: 'test input',
    signal: controller.signal,
  });

  expect(result.status).toBe('cancelled');
  expect(stage1Completed).toBe(true);
  expect(result.stages).toHaveLength(1);
  expect(result.stages[0].stage_name).toBe('stage-1');
  expect(result.stages[0].status).toBe('success');
});
```

### Step 4: Write Test C — group cancellation

```typescript
it('cancels cleanly when signal is aborted during a group stage', async () => {
  const controller = new AbortController();

  // Slow provider — abort fires before it resolves
  const slowProvider = {
    name: 'anthropic',
    call: vi.fn().mockImplementation(
      () => new Promise((resolve) =>
        setTimeout(() => resolve({
          content: JSON.stringify({ summary: 'done', requirements: [], acceptance_criteria: [] }),
          tool_calls: [],
          finish_reason: 'stop',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }), 100)
      )
    ),
  };

  const engine = createTestEngine({
    providerRegistry: { get: vi.fn().mockReturnValue(slowProvider), register: vi.fn() } as any,
  });

  setTimeout(() => controller.abort(), 10);

  const result = await engine.run({
    pipeline: 'group-simple',
    input: 'test input',
    signal: controller.signal,
  });

  expect(result.status).toBe('cancelled');
});
```

### Step 5: Run the new tests

```bash
pnpm --filter @studio-foundation/engine test engine/tests/unit/engine.test.ts 2>&1 | tail -30
```

Expected: all 3 new tests pass. If any fail, investigate with `DEBUG=studio:* pnpm test`.

### Step 6: Run full engine test suite

```bash
pnpm --filter @studio-foundation/engine test
```

Expected: all tests pass.

### Step 7: Commit

```bash
git add engine/tests/unit/engine.test.ts
git commit -m "test(engine): add cancellation tests for mid-run, between stages, and group"
```

---

## Task 3: SSE Double-Close Fix

**Files:**
- Modify: `api/src/launcher.ts`
- Modify: `api/tests/launcher.test.ts`

### Step 1: Write the failing test

In `api/tests/launcher.test.ts`, add after the existing cancel tests:

```typescript
it('pipeline_complete event is received by bus subscribers after cancellation', async () => {
  const store = new InMemoryRunStore();
  const bus = new RunEventBus();
  const receivedEventTypes: string[] = [];

  // Subscribe to the bus before the run starts
  // (subscribe will be called in the test setup, run hasn't launched yet)

  let capturedEvents: EngineEvents;
  const { factory } = makeMockFactory((events) => {
    capturedEvents = events;
  });
  // Override run to do nothing (we'll fire events manually)
  factory.mockImplementation((_cfg: EngineConfig, events: EngineEvents) => {
    capturedEvents = events;
    return {
      run: vi.fn().mockImplementation(async () => {
        // Fire events in sequence like the engine does for a cancelled run
        events.onPipelineStart?.({ pipeline_name: 'p', run_id: 'run-cancel-sse' });
        events.onPipelineCancelled?.({ run_id: 'run-cancel-sse', cancelled_at_stage: 'stage-1', duration_ms: 10 });
        events.onPipelineComplete?.({ pipeline_name: 'p', run_id: 'run-cancel-sse', status: 'cancelled', duration_ms: 10, total_tokens: 0, total_tool_calls: 0 });
        return { id: 'run-cancel-sse', pipeline_name: 'p', status: 'cancelled', started_at: '', stages: [] };
      }),
    };
  });

  const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);

  await launcher.launch({ runId: 'run-cancel-sse', pipeline: 'p', input: {}, configsDir: TMP_RUNS_DIR });

  // Subscribe after launch (bus is set up before run completes)
  const unsub = bus.subscribe('run-cancel-sse', (e) => receivedEventTypes.push(e.type));

  // Wait for the async run to complete
  await new Promise((r) => setTimeout(r, 50));

  // pipeline_complete should have arrived (and is the terminal event that closes the bus)
  expect(receivedEventTypes).toContain('pipeline_cancelled');
  expect(receivedEventTypes).toContain('pipeline_complete');
  unsub();
});
```

**Note:** This test is tricky because the bus events fire during the async engine.run() before any subscriber has been attached. The real fix is simpler to verify by checking the bus isn't closed before `pipeline_complete`. An alternative simpler test:

```typescript
it('bus stays open after pipeline_cancelled so pipeline_complete can close it', async () => {
  const store = new InMemoryRunStore();
  const bus = new RunEventBus();
  const closeSpy = vi.spyOn(bus, 'close');

  let capturedEvents!: EngineEvents;
  const factory = vi.fn().mockImplementation((_cfg: EngineConfig, events: EngineEvents) => {
    capturedEvents = events;
    return { run: vi.fn().mockResolvedValue({ id: 'r1', pipeline_name: 'p', status: 'cancelled', started_at: '', stages: [] }) };
  });

  const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);
  await launcher.launch({ runId: 'r1', pipeline: 'p', input: {}, configsDir: TMP_RUNS_DIR });
  await new Promise((r) => setTimeout(r, 10)); // let factory.run capture events

  // Manually fire engine events in order (as the engine does for a cancelled run)
  capturedEvents.onPipelineCancelled?.({ run_id: 'r1', cancelled_at_stage: 's1', duration_ms: 5 });
  // Bus should NOT be closed yet
  expect(closeSpy).not.toHaveBeenCalledWith('r1');

  capturedEvents.onPipelineComplete?.({ pipeline_name: 'p', run_id: 'r1', status: 'cancelled', duration_ms: 5, total_tokens: 0, total_tool_calls: 0 });
  // Bus should be closed now
  expect(closeSpy).toHaveBeenCalledWith('r1');
  // And only once
  expect(closeSpy).toHaveBeenCalledTimes(1);
});
```

Use the second simpler test (bus.close spy).

### Step 2: Run to verify failure

```bash
pnpm --filter @studio-foundation/api test api/tests/launcher.test.ts 2>&1 | tail -20
```

Expected: test fails — `closeSpy` is called once by `onPipelineCancelled`, not by `onPipelineComplete`.

### Step 3: Apply the fix in launcher.ts

In `api/src/launcher.ts`, find `onPipelineCancelled` and remove `this.bus.close(runId)`:

```typescript
// Before:
onPipelineCancelled: (e: PipelineCancelledEvent) => {
  emit('pipeline_cancelled', e);
  this.bus.close(runId);
},

// After:
onPipelineCancelled: (e: PipelineCancelledEvent) => {
  emit('pipeline_cancelled', e);
},
```

### Step 4: Run to verify fix

```bash
pnpm --filter @studio-foundation/api test api/tests/launcher.test.ts 2>&1 | tail -20
```

Expected: new test passes, all existing launcher tests still pass.

### Step 5: Run full API test suite

```bash
pnpm --filter @studio-foundation/api test
```

Expected: all tests pass.

### Step 6: Commit

```bash
git add api/src/launcher.ts api/tests/launcher.test.ts
git commit -m "fix(api): pipeline_complete not received by SSE subscribers on cancellation"
```

---

## Task 4: DELETE /api/runs/:id Endpoint

**Files:**
- Modify: `api/src/routes/runs.ts`
- Modify: `api/tests/cancel.test.ts`

### Step 1: Write 3 failing tests

Add to `api/tests/cancel.test.ts` (new `describe` block after the POST tests):

```typescript
describe('DELETE /api/runs/:id', () => {
  it('returns 200 with run_id when run is running', async () => {
    const store = new InMemoryRunStore();
    const cancelFn = vi.fn().mockResolvedValue(undefined);
    store.savePipelineRun(makeRun({ id: 'run-del-1', status: 'running' }));
    const server = makeServer(store, { cancel: cancelFn });

    const res = await server.inject({ method: 'DELETE', url: '/api/runs/run-del-1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ run_id: 'run-del-1' });
    expect(cancelFn).toHaveBeenCalledWith('run-del-1');
  });

  it('returns 404 when run does not exist', async () => {
    const server = makeServer();

    const res = await server.inject({ method: 'DELETE', url: '/api/runs/nonexistent' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it('returns 409 when run is already terminal', async () => {
    const store = new InMemoryRunStore();
    store.savePipelineRun(makeRun({ id: 'run-done', status: 'success' }));
    const server = makeServer(store);

    const res = await server.inject({ method: 'DELETE', url: '/api/runs/run-done' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not cancellable/i);
  });
});
```

### Step 2: Run to verify failure

```bash
pnpm --filter @studio-foundation/api test api/tests/cancel.test.ts 2>&1 | tail -20
```

Expected: 3 new tests fail (404 — route not registered)

### Step 3: Add DELETE route to runs.ts

In `api/src/routes/runs.ts`, add after the existing `POST /runs/:id/cancel` handler (around line 314):

```typescript
// DELETE /api/runs/:id — cancel a running pipeline (spec-aligned alias for POST /cancel)
fastify.delete<{ Params: { id: string } }>('/runs/:id', {
  schema: {
    tags: ['runs'],
    summary: 'Cancel a running pipeline (DELETE alias)',
    params: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    response: {
      200: {
        type: 'object',
        properties: { run_id: { type: 'string' } },
      },
      404: errorSchema,
      409: errorSchema,
    },
  },
}, async (request, reply) => {
  const { id } = request.params;
  const run = await store.getPipelineRun(id);
  if (!run) {
    return reply.status(404).send({ error: 'Run not found' });
  }
  if (run.status !== 'running') {
    return reply.status(409).send({ error: `Run is not cancellable (status: ${run.status})` });
  }
  await launcher.cancel(id);
  return reply.send({ run_id: id });
});
```

### Step 4: Run to verify tests pass

```bash
pnpm --filter @studio-foundation/api test api/tests/cancel.test.ts 2>&1 | tail -20
```

Expected: all 7 cancel tests pass (4 original + 3 new)

### Step 5: Run full API test suite

```bash
pnpm --filter @studio-foundation/api test
```

Expected: all tests pass.

### Step 6: Commit

```bash
git add api/src/routes/runs.ts api/tests/cancel.test.ts
git commit -m "feat(api): add DELETE /api/runs/:id endpoint for cancel (STU-25 spec)"
```

---

## Final Steps

### Build

```bash
pnpm build
```

Expected: all packages build cleanly.

### Full test suite

```bash
pnpm test
```

Expected: all tests pass.

### Commit if build/tests revealed anything to fix

Only if needed.

### Open PR

```bash
git push -u origin arianedguay/stu-25-phase-4-cancel-run-graceful-shutdown
gh pr create \
  --title "[STU-25] feat(api,engine): cancel run graceful shutdown — close gaps" \
  --body "$(cat <<'EOF'
## Summary

- **fix(api)**: `pipeline_complete` event now reaches SSE subscribers for cancelled runs (bus was being closed prematurely by `onPipelineCancelled` handler)
- **feat(api)**: add `DELETE /api/runs/:id` endpoint as spec-aligned alias for `POST /runs/:id/cancel`
- **feat(engine)**: add `'cancel'` transition to state machine (`'running:cancel': 'cancelled'`) for consistency
- **test(engine)**: add 3 new cancellation tests — mid-run signal abort, between-stage abort, group abort

## Background

STU-25 specified graceful cancellation via `DELETE /runs/:id` and `Ctrl+C`. The core implementation (AbortSignal propagation through ralph/engine/runner/CLI) was completed in STU-131 (PR #103). This PR closes the 4 remaining gaps.

## Packages touched

- `@studio-foundation/api` — launcher.ts (SSE fix), routes/runs.ts (DELETE endpoint)
- `@studio-foundation/engine` — state/state-machine.ts (cancel transition), engine.ts (use transition())

## How to test

```bash
# All tests
pnpm test

# API cancel endpoint
curl -X DELETE http://localhost:3000/api/runs/<run-id>

# CLI graceful shutdown
studio run my-pipeline --input "test" &
# then Ctrl+C → should print "⚠ Cancelling run..." and exit 130
```
EOF
)" \
  --base main
```
