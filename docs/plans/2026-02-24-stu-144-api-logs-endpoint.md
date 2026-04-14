# STU-144 — GET /runs/:id/logs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update `GET /api/runs/:id/logs` to return structured JSON by default and raw JSONL when `?raw=true` is passed.

**Architecture:** The endpoint already exists in `api/src/routes/runs.ts` with correct 404 handling. We add a `?raw` querystring param, add JSONL parsing logic for the default structured response, and preserve the existing raw behavior behind `?raw=true`. No new files needed.

**Tech Stack:** Fastify (route schema), Node.js `fs/promises` (already imported), Vitest + `node:fs` (tests write temp JSONL files).

---

### Task 1: Write failing tests for new behavior

**Files:**
- Modify: `api/tests/runs.test.ts`

**Step 1: Add imports at the top of the test file**

Open `api/tests/runs.test.ts`. Add these imports after the existing imports:

```typescript
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
```

**Step 2: Add a helper for creating temp log files**

Add this helper function after the `makeServer` function (around line 28):

```typescript
function makeTempLog(lines: string[]): { logPath: string; cleanup: () => void } {
  const dir = resolve(tmpdir(), `studio-test-logs-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const logPath = resolve(dir, 'test.jsonl');
  writeFileSync(logPath, lines.join('\n') + '\n');
  return { logPath, cleanup: () => rmSync(dir, { recursive: true }) };
}
```

**Step 3: Add 4 new tests inside the existing `describe('GET /api/runs/:id/logs')` block**

Append these inside the describe block, after the existing 3 tests:

```typescript
  it('returns structured JSON with parsed entries by default', async () => {
    const { logPath, cleanup } = makeTempLog([
      JSON.stringify({ ts: '2026-01-01T10:00:00Z', event: 'onPipelineStart', pipeline_name: 'feature-builder' }),
      JSON.stringify({ ts: '2026-01-01T10:01:00Z', event: 'onStageComplete', stage_name: 'code-gen', status: 'success' }),
    ]);
    store.savePipelineRun(makeRun({ id: 'run-structured' }));
    store.saveLogPath('run-structured', logPath);
    const server = makeServer(store);

    const res = await server.inject({ method: 'GET', url: '/api/runs/run-structured/logs' });
    cleanup();

    expect(res.statusCode).toBe(200);
    const body = res.json() as { run_id: string; entries: Array<{ event: string; timestamp: string; data: Record<string, unknown> }> };
    expect(body.run_id).toBe('run-structured');
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toEqual({
      event: 'onPipelineStart',
      timestamp: '2026-01-01T10:00:00Z',
      data: { pipeline_name: 'feature-builder' },
    });
    expect(body.entries[1]).toEqual({
      event: 'onStageComplete',
      timestamp: '2026-01-01T10:01:00Z',
      data: { stage_name: 'code-gen', status: 'success' },
    });
  });

  it('returns raw text/plain with ?raw=true', async () => {
    const rawContent = JSON.stringify({ ts: '2026-01-01T10:00:00Z', event: 'onPipelineStart' }) + '\n';
    const { logPath, cleanup } = makeTempLog([rawContent.trimEnd()]);
    store.savePipelineRun(makeRun({ id: 'run-raw' }));
    store.saveLogPath('run-raw', logPath);
    const server = makeServer(store);

    const res = await server.inject({ method: 'GET', url: '/api/runs/run-raw/logs?raw=true' });
    cleanup();

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).toBe(rawContent);
  });

  it('skips malformed JSON lines in structured mode', async () => {
    const { logPath, cleanup } = makeTempLog([
      'not valid json',
      JSON.stringify({ ts: '2026-01-01T10:00:00Z', event: 'onPipelineStart' }),
      '{ broken',
    ]);
    store.savePipelineRun(makeRun({ id: 'run-malformed' }));
    store.saveLogPath('run-malformed', logPath);
    const server = makeServer(store);

    const res = await server.inject({ method: 'GET', url: '/api/runs/run-malformed/logs' });
    cleanup();

    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: unknown[] };
    expect(body.entries).toHaveLength(1);
  });

  it('skips lines without event field in structured mode', async () => {
    const { logPath, cleanup } = makeTempLog([
      JSON.stringify({ ts: '2026-01-01T10:00:00Z', event: 'onPipelineStart' }),
      JSON.stringify({ ts: '2026-01-01T10:00:01Z', some_field: 'no_event_here' }),
    ]);
    store.savePipelineRun(makeRun({ id: 'run-no-event' }));
    store.saveLogPath('run-no-event', logPath);
    const server = makeServer(store);

    const res = await server.inject({ method: 'GET', url: '/api/runs/run-no-event/logs' });
    cleanup();

    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: unknown[] };
    expect(body.entries).toHaveLength(1);
  });
```

**Step 4: Run the new tests to confirm they fail**

```bash
pnpm --filter @studio-foundation/api test
```

Expected: 4 new tests fail. Existing 3 tests in the logs describe block still pass.

---

### Task 2: Update the route to pass the tests

**Files:**
- Modify: `api/src/routes/runs.ts:107-137`

**Step 1: Replace the `GET /api/runs/:id/logs` handler**

Find the existing handler (starts at the `// GET /api/runs/:id/logs` comment, around line 107). Replace the entire route definition with:

```typescript
  // GET /api/runs/:id/logs
  fastify.get<{
    Params: { id: string };
    Querystring: { raw?: string };
  }>('/runs/:id/logs', {
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      querystring: {
        type: 'object',
        properties: { raw: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const isRaw = request.query.raw === 'true';

    const run = store.getPipelineRun(id);
    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    const logPath = store.getLogPath(id);
    if (!logPath) {
      return reply.status(404).send({ error: 'Log not yet available' });
    }

    let content: string;
    try {
      content = await readFile(logPath, 'utf-8');
    } catch {
      return reply.status(404).send({ error: 'Log file not found' });
    }

    if (isRaw) {
      return reply.type('text/plain').send(content);
    }

    const entries: Array<{ event: string; timestamp: string; data: Record<string, unknown> }> = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const { event, ts, ...data } = parsed;
        if (typeof event !== 'string') continue;
        entries.push({ event, timestamp: typeof ts === 'string' ? ts : '', data });
      } catch {
        // skip malformed lines
      }
    }

    return reply.send({ run_id: id, entries });
  });
```

**Step 2: Run all API tests**

```bash
pnpm --filter @studio-foundation/api test
```

Expected: All tests pass, including the 4 new ones.

---

### Task 3: Build and commit

**Step 1: Build the monorepo**

```bash
pnpm build
```

Expected: exits 0.

**Step 2: Commit**

```bash
git add api/src/routes/runs.ts api/tests/runs.test.ts
git commit -m "feat(api): structured JSON response for GET /runs/:id/logs (STU-144)"
```
