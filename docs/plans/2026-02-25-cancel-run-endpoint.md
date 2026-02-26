# Cancel Run Endpoint Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `POST /api/runs/:id/cancel` that sends an abort signal to a running pipeline and returns immediately.

**Architecture:** Pure route addition in `@studio/api`. All cancellation infrastructure (abort signal, `cancelled` status, `pipeline_cancelled` SSE event) already exists in the engine and launcher — we just need the HTTP endpoint. TDD: write failing tests first, then implement.

**Tech Stack:** Fastify (route), Vitest (tests), InMemoryRunStore + mock launcher (test fixtures)

---

### Task 1: Write failing tests for the cancel endpoint

**Files:**
- Create: `api/tests/cancel.test.ts`

**Step 1: Create the test file**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio/engine';
import type { RunLauncher } from '../src/launcher.js';
import type { PipelineRun } from '@studio/contracts';

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'run-abc',
    pipeline_name: 'test-pipeline',
    status: 'running',
    started_at: '2026-01-01T10:00:00Z',
    stages: [],
    ...overrides,
  } as PipelineRun;
}

function makeServer(store = new InMemoryRunStore(), launcher?: Partial<RunLauncher>) {
  return buildServer({
    store,
    launcher: {
      launch: vi.fn().mockResolvedValue({ run_id: 'new-run' }),
      cancel: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockReturnValue(() => {}),
      ...launcher,
    } as RunLauncher,
    configsDir: '/tmp/.studio',
    projectName: 'test',
    apiConfig: {},
  } as any);
}

describe('POST /api/runs/:id/cancel', () => {
  it('returns 200 with run_id when run is running', async () => {
    const store = new InMemoryRunStore();
    const cancelFn = vi.fn().mockResolvedValue(undefined);
    store.savePipelineRun(makeRun({ id: 'run-1', status: 'running' }));
    const server = makeServer(store, { cancel: cancelFn });

    const res = await server.inject({ method: 'POST', url: '/api/runs/run-1/cancel' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ run_id: 'run-1' });
    expect(cancelFn).toHaveBeenCalledWith('run-1');
  });

  it('returns 404 when run does not exist', async () => {
    const server = makeServer();

    const res = await server.inject({ method: 'POST', url: '/api/runs/nonexistent/cancel' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it('returns 409 when run is already success', async () => {
    const store = new InMemoryRunStore();
    store.savePipelineRun(makeRun({ id: 'run-done', status: 'success' }));
    const server = makeServer(store);

    const res = await server.inject({ method: 'POST', url: '/api/runs/run-done/cancel' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not cancellable/i);
  });

  it('returns 409 for failed and cancelled statuses', async () => {
    for (const status of ['failed', 'cancelled'] as const) {
      const store = new InMemoryRunStore();
      store.savePipelineRun(makeRun({ id: 'run-x', status }));
      const server = makeServer(store);

      const res = await server.inject({ method: 'POST', url: '/api/runs/run-x/cancel' });

      expect(res.statusCode).toBe(409);
    }
  });
});
```

**Step 2: Run the tests to confirm they fail**

```bash
cd /home/arianeguay/dev/src/Studio/.worktrees/stu-145-cancel
pnpm --filter @studio/api test -- --reporter=verbose 2>&1 | grep -A3 "cancel"
```

Expected: 4 test failures with `404` (route doesn't exist yet → Fastify returns 404 for unknown routes).

**Step 3: Commit the failing tests**

```bash
cd /home/arianeguay/dev/src/Studio/.worktrees/stu-145-cancel
git add api/tests/cancel.test.ts
git commit -m "test(api): failing tests for POST /runs/:id/cancel (STU-145)"
```

---

### Task 2: Implement the cancel route

**Files:**
- Modify: `api/src/routes/runs.ts`

**Step 1: Fix `pipelineRunSchema` enum (missing `'cancelled'`)**

In `api/src/routes/runs.ts`, find the `pipelineRunSchema` constant (around line 40-50). Change:

```typescript
status: { type: 'string', enum: ['pending', 'running', 'success', 'failed', 'rejected', 'skipped'] },
```

To:

```typescript
status: { type: 'string', enum: ['pending', 'running', 'success', 'failed', 'rejected', 'skipped', 'cancelled'] },
```

**Step 2: Add the cancel route**

In `api/src/routes/runs.ts`, after the `GET /api/runs/:id/logs` route (around line 239) and before `GET /api/runs/:id/stream`, add:

```typescript
  // POST /api/runs/:id/cancel
  fastify.post<{ Params: { id: string } }>('/runs/:id/cancel', {
    schema: {
      tags: ['runs'],
      summary: 'Cancel a running pipeline',
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
    const run = store.getPipelineRun(id);
    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }
    if (run.status !== 'running') {
      return reply.status(409).send({ error: `Run is not cancellable (status: ${run.status})` });
    }
    await options.deps.launcher.cancel(id);
    return reply.send({ run_id: id });
  });
```

Note: `store` is already declared at the top of `runsRoutes` as `const { store, launcher } = options.deps;` — use that reference, don't add another destructure.

**Step 3: Run the tests to confirm they pass**

```bash
cd /home/arianeguay/dev/src/Studio/.worktrees/stu-145-cancel
pnpm --filter @studio/api test -- --reporter=verbose 2>&1 | grep -E "cancel|✓|×"
```

Expected: all 4 cancel tests pass.

**Step 4: Run full API test suite to confirm no regressions**

```bash
pnpm --filter @studio/api test 2>&1 | tail -5
```

Expected: same pass/fail count as before (5 pre-existing failures unrelated to this PR, 150+ passing).

**Step 5: Build to confirm TypeScript compiles**

```bash
cd /home/arianeguay/dev/src/Studio/.worktrees/stu-145-cancel
pnpm build 2>&1 | tail -5
```

Expected: clean build, no errors.

**Step 6: Commit**

```bash
cd /home/arianeguay/dev/src/Studio/.worktrees/stu-145-cancel
git add api/src/routes/runs.ts
git commit -m "feat(api): POST /runs/:id/cancel — cancel a running pipeline (STU-145)"
```

---

### Task 3: Open the PR

```bash
cd /home/arianeguay/dev/src/Studio/.worktrees/stu-145-cancel
git push -u origin arianedguay/stu-145-api-post-runsidcancel-arreter-un-run-en-cours
gh pr create \
  --title "feat(api): POST /runs/:id/cancel — arrêter un run en cours (STU-145)" \
  --body "$(cat <<'EOF'
## Summary

- Adds `POST /api/runs/:id/cancel` endpoint
- Returns `200 { run_id }` immediately after sending the abort signal
- Returns `404` if run not found, `409` if run is not in `running` state
- Fixes `pipelineRunSchema` enum to include `'cancelled'` (was missing, DB could already return it)

## How it works

All cancel infrastructure already existed (AbortController in launcher, cancelled status in engine, pipeline_cancelled SSE event). This PR just adds the HTTP endpoint.

## Packages touched

- `@studio/api` — new route + schema fix

## How to test

```bash
# Start a long-running pipeline
curl -X POST http://localhost:3000/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"pipeline":"feature-builder","input":{"brief":"test"}}'
# → { run_id: "abc-123", ... }

# Cancel it
curl -X POST http://localhost:3000/api/runs/abc-123/cancel
# → 200 { run_id: "abc-123" }

# Confirm cancelled
curl http://localhost:3000/api/runs/abc-123
# → { status: "cancelled", ... }
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" \
  --base main
```
