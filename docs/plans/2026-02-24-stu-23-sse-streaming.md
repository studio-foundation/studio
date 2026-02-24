# STU-23 — SSE Streaming Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `GET /api/runs/:id/stream` SSE endpoint that replays historical events then streams live events for in-progress runs.

**Architecture:** Per-run `PipelineEngine` instances with a `RunEventBus` (in-memory pub/sub) for SSE routing. No engine changes — all new code lives in `@studio/api`. JSONL logger extended to write all structural events for replay.

**Tech Stack:** Fastify v5, Node.js raw HTTP streams (`reply.raw`), TypeScript, Vitest.

---

## Setup

### Task 0: Branch off feat/stu-22-api

**Step 1: Create branch**

```bash
git checkout feat/stu-22-api
git checkout -b feat/stu-23-sse
```

**Step 2: Verify existing tests pass**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm --filter @studio/api test
```

Expected: all existing launcher + server tests pass.

---

## Task 1: RunEventBus

**Files:**
- Create: `api/tests/event-bus.test.ts`
- Create: `api/src/event-bus.ts`

### Step 1: Write the failing test

`api/tests/event-bus.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { RunEventBus } from '../src/event-bus.js';

describe('RunEventBus', () => {
  it('delivers events to subscribers', () => {
    const bus = new RunEventBus();
    const received: unknown[] = [];
    bus.subscribe('run-1', (e) => received.push(e));
    bus.emit('run-1', 'stage_complete', { stage: 'brief-analysis' });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'stage_complete', data: { stage: 'brief-analysis' } });
  });

  it('unsubscribe stops delivery', () => {
    const bus = new RunEventBus();
    const received: unknown[] = [];
    const unsub = bus.subscribe('run-1', (e) => received.push(e));
    unsub();
    bus.emit('run-1', 'stage_complete', {});
    expect(received).toHaveLength(0);
  });

  it('close emits done then cleans up', () => {
    const bus = new RunEventBus();
    const types: string[] = [];
    bus.subscribe('run-1', (e) => types.push(e.type));
    bus.close('run-1');
    expect(types).toEqual(['done']);
    // After close, no more events
    bus.emit('run-1', 'stage_complete', {});
    expect(types).toHaveLength(1);
  });

  it('isolates events between runs', () => {
    const bus = new RunEventBus();
    const run1: unknown[] = [];
    const run2: unknown[] = [];
    bus.subscribe('run-1', (e) => run1.push(e));
    bus.subscribe('run-2', (e) => run2.push(e));
    bus.emit('run-1', 'stage_complete', {});
    expect(run1).toHaveLength(1);
    expect(run2).toHaveLength(0);
  });

  it('supports multiple subscribers on same run', () => {
    const bus = new RunEventBus();
    let count = 0;
    bus.subscribe('run-1', () => count++);
    bus.subscribe('run-1', () => count++);
    bus.emit('run-1', 'pipeline_complete', {});
    expect(count).toBe(2);
  });
});
```

### Step 2: Run — verify FAIL

```bash
pnpm --filter @studio/api test event-bus
```

Expected: `Cannot find module '../src/event-bus.js'`

### Step 3: Implement `api/src/event-bus.ts`

```typescript
export type SseEventType =
  | 'stage_start'
  | 'stage_complete'
  | 'stage_retry'
  | 'group_start'
  | 'group_iteration'
  | 'group_feedback'
  | 'group_complete'
  | 'pipeline_complete'
  | 'pipeline_cancelled'
  | 'done';

export interface BusEvent {
  type: SseEventType;
  data: unknown;
}

export type BusListener = (event: BusEvent) => void;

export class RunEventBus {
  private subs = new Map<string, Set<BusListener>>();

  subscribe(runId: string, listener: BusListener): () => void {
    if (!this.subs.has(runId)) {
      this.subs.set(runId, new Set());
    }
    this.subs.get(runId)!.add(listener);
    return () => {
      this.subs.get(runId)?.delete(listener);
    };
  }

  emit(runId: string, type: SseEventType, data: unknown): void {
    const listeners = this.subs.get(runId);
    if (!listeners) return;
    const event: BusEvent = { type, data };
    for (const listener of listeners) {
      listener(event);
    }
  }

  close(runId: string): void {
    this.emit(runId, 'done', {});
    this.subs.delete(runId);
  }
}
```

### Step 4: Run — verify PASS

```bash
pnpm --filter @studio/api test event-bus
```

Expected: 5 tests pass.

### Step 5: Commit

```bash
git add api/src/event-bus.ts api/tests/event-bus.test.ts
git commit -m "feat(api): add RunEventBus for per-run SSE event routing"
```

---

## Task 2: Refactor InProcessLauncher

**Files:**
- Modify: `api/src/launcher.ts`
- Modify: `api/tests/launcher.test.ts`

The launcher receives `EngineConfig` instead of a `PipelineEngine` instance. It creates one engine per run via an injectable `engineFactory` (default: `new PipelineEngine(config, events)`). This preserves testability without `vi.mock`.

### Step 1: Update the launcher tests

Replace `api/tests/launcher.test.ts` entirely:

```typescript
import { describe, it, expect, vi, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { InProcessLauncher } from '../src/launcher.js';
import { RunEventBus } from '../src/event-bus.js';
import { InMemoryRunStore } from '@studio/engine';
import type { EngineConfig, EngineEvents } from '@studio/engine';

const TMP_RUNS_DIR = resolve('/tmp', `studio-launcher-test-${Date.now()}`);

afterAll(() => {
  rmSync(TMP_RUNS_DIR, { recursive: true, force: true });
});

// Minimal EngineConfig stub — launcher only passes it to engineFactory
const stubConfig = {} as EngineConfig;

function makeMockFactory(onEvents?: (events: EngineEvents) => void) {
  const runFn = vi.fn().mockResolvedValue({
    id: 'test-run-id',
    pipeline_name: 'test-pipeline',
    status: 'success',
    started_at: new Date().toISOString(),
    stages: [],
  });
  const factory = vi.fn().mockImplementation((_cfg: EngineConfig, events: EngineEvents) => {
    onEvents?.(events);
    return { run: runFn };
  });
  return { factory, runFn };
}

describe('InProcessLauncher', () => {
  it('launch returns run_id immediately (fire-and-forget)', async () => {
    let engineStarted = false;
    let engineCompleted = false;
    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    const { factory } = makeMockFactory();
    factory.mockImplementation(() => ({
      run: vi.fn().mockImplementation(async () => {
        engineStarted = true;
        await new Promise((r) => setTimeout(r, 50));
        engineCompleted = true;
        return { id: 'run-1', pipeline_name: 'p', status: 'success', started_at: '', stages: [] };
      }),
    }));

    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);
    const result = await launcher.launch({
      runId: 'run-1',
      pipeline: 'test-pipeline',
      input: {},
      configsDir: TMP_RUNS_DIR,
    });

    expect(result.run_id).toBe('run-1');
    expect(engineStarted).toBe(true);
    expect(engineCompleted).toBe(false);
  });

  it('saves log path to store immediately after launch', async () => {
    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    const { factory } = makeMockFactory();
    factory.mockImplementation(() => ({
      run: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { id: 'run-log', pipeline_name: 'p', status: 'success', started_at: '', stages: [] };
      }),
    }));

    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);
    await launcher.launch({ runId: 'run-log', pipeline: 'test-pipeline', input: {}, configsDir: TMP_RUNS_DIR });

    const logPath = store.getLogPath('run-log');
    expect(logPath).not.toBeNull();
    expect(logPath).toContain('test-pipeline');
    expect(logPath).toContain('.jsonl');
  });

  it('subscribe delivers events emitted during a run', async () => {
    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    let capturedEvents: EngineEvents = {};

    const { factory } = makeMockFactory((evts) => { capturedEvents = evts; });
    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);

    const received: string[] = [];
    launcher.subscribe('run-evt', ({ type }) => received.push(type));

    await launcher.launch({ runId: 'run-evt', pipeline: 'p', input: {}, configsDir: TMP_RUNS_DIR });

    // Simulate engine emitting events
    capturedEvents.onStageComplete?.({ stage_name: 's', stage_index: 0, total_stages: 1, status: 'success', attempts: 1, duration_ms: 100 });
    capturedEvents.onPipelineComplete?.({ pipeline_name: 'p', run_id: 'run-evt', status: 'success', duration_ms: 200, total_tokens: 100, total_tool_calls: 0 });

    expect(received).toContain('stage_complete');
    expect(received).toContain('pipeline_complete');
    expect(received).toContain('done'); // bus.close called after pipeline_complete
  });

  it('cancel aborts a running pipeline', async () => {
    let abortSeen = false;
    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    const { factory } = makeMockFactory();
    factory.mockImplementation(() => ({
      run: vi.fn().mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
        await new Promise((r) => setTimeout(r, 200));
        abortSeen = signal?.aborted ?? false;
        return { id: 'run-cancel', pipeline_name: 'p', status: 'failed', started_at: '', stages: [] };
      }),
    }));

    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);
    await launcher.launch({ runId: 'run-cancel', pipeline: 'p', input: {}, configsDir: TMP_RUNS_DIR });
    await launcher.cancel('run-cancel');
    await new Promise((r) => setTimeout(r, 250));
    expect(abortSeen).toBe(true);
  });

  it('cancel ignores unknown run_id', async () => {
    const launcher = new InProcessLauncher(stubConfig, new InMemoryRunStore(), TMP_RUNS_DIR, new RunEventBus());
    await expect(launcher.cancel('nonexistent')).resolves.toBeUndefined();
  });
});
```

### Step 2: Run — verify FAIL

```bash
pnpm --filter @studio/api test launcher
```

Expected: TypeScript errors about constructor mismatch.

### Step 3: Implement new `api/src/launcher.ts`

```typescript
// Run launcher — interface + InProcessLauncher implementation
// InProcessLauncher creates a new PipelineEngine per run for event isolation.
// Future: BullMQLauncher, etc.

import type {
  EngineConfig,
  EngineEvents,
  RunStore,
  StageStartEvent,
  StageCompleteEvent,
  StageRetryEvent,
  GroupStartEvent,
  GroupIterationEvent,
  GroupFeedbackEvent,
  GroupCompleteEvent,
  PipelineCompleteEvent,
  PipelineCancelledEvent,
} from '@studio/engine';
import { PipelineEngine } from '@studio/engine';
import { createApiLogger } from './logger.js';
import type { RunEventBus, BusListener, SseEventType } from './event-bus.js';

export interface LaunchConfig {
  runId: string;
  pipeline: string;
  input: Record<string, unknown>;
  configsDir: string;
  providerOverride?: string;
}

export type EngineFactory = (
  config: EngineConfig,
  events: EngineEvents,
) => Pick<PipelineEngine, 'run'>;

export interface RunLauncher {
  launch(config: LaunchConfig): Promise<{ run_id: string }>;
  cancel(run_id: string): Promise<void>;
  subscribe(runId: string, listener: BusListener): () => void;
}

export class InProcessLauncher implements RunLauncher {
  private active = new Map<string, AbortController>();

  constructor(
    private engineConfig: EngineConfig,
    private store: RunStore,
    private runsDir: string,
    private bus: RunEventBus,
    private engineFactory: EngineFactory = (cfg, evts) => new PipelineEngine(cfg, evts),
  ) {}

  subscribe(runId: string, listener: BusListener): () => void {
    return this.bus.subscribe(runId, listener);
  }

  async launch(config: LaunchConfig): Promise<{ run_id: string }> {
    const { runId, pipeline, input } = config;
    const controller = new AbortController();
    this.active.set(runId, controller);

    const logger = createApiLogger(this.runsDir, runId, pipeline);
    this.store.saveLogPath(runId, logger.logPath);

    const emit = (type: SseEventType, data: object) => {
      this.bus.emit(runId, type, data);
      logger.log({ event: type, ...(data as Record<string, unknown>) });
    };

    const perRunEvents: EngineEvents = {
      onStageStart:        (e: StageStartEvent) =>        emit('stage_start', e),
      onStageComplete:     (e: StageCompleteEvent) =>     emit('stage_complete', e),
      onTaskRetry:         (e: StageRetryEvent) =>        emit('stage_retry', e),
      onGroupStart:        (e: GroupStartEvent) =>        emit('group_start', e),
      onGroupIteration:    (e: GroupIterationEvent) =>    emit('group_iteration', e),
      onGroupFeedback:     (e: GroupFeedbackEvent) =>     emit('group_feedback', e),
      onGroupComplete:     (e: GroupCompleteEvent) =>     emit('group_complete', e),
      onPipelineComplete:  (e: PipelineCompleteEvent) => {
        emit('pipeline_complete', e);
        this.bus.close(runId);
      },
      onPipelineCancelled: (e: PipelineCancelledEvent) => {
        emit('pipeline_cancelled', e);
        this.bus.close(runId);
      },
    };

    const engine = this.engineFactory(this.engineConfig, perRunEvents);

    void engine
      .run({ pipeline, input, signal: controller.signal, id: runId })
      .then(async () => {
        await logger.close();
      })
      .catch(async (err: unknown) => {
        logger.log({ event: 'pipeline_error', error: String(err) });
        this.bus.close(runId);
        await logger.close();
      })
      .finally(() => {
        this.active.delete(runId);
      });

    return { run_id: runId };
  }

  async cancel(run_id: string): Promise<void> {
    this.active.get(run_id)?.abort();
  }
}
```

### Step 4: Run — verify PASS

```bash
pnpm --filter @studio/api test launcher
```

Expected: all launcher tests pass.

### Step 5: Commit

```bash
git add api/src/launcher.ts api/tests/launcher.test.ts
git commit -m "refactor(api): InProcessLauncher — per-run engine instances + RunEventBus"
```

---

## Task 3: Update bootstrap.ts

**Files:**
- Modify: `api/src/bootstrap.ts`

No new tests — bootstrap is covered by integration tests.

### Step 1: Update bootstrap.ts

In `api/src/bootstrap.ts`, replace the engine instantiation with `engineConfig` and wire the bus:

**Add import at top:**
```typescript
import { RunEventBus } from './event-bus.js';
```

**Replace this block:**
```typescript
const engine = new PipelineEngine({
  configsDir: studioDir,
  providerRegistry,
  toolRegistry,
  db: store,
  pluginSkills,
});

const launcher = new InProcessLauncher(engine, store, runsDir);
```

**With:**
```typescript
const engineConfig: EngineConfig = {
  configsDir: studioDir,
  providerRegistry,
  toolRegistry,
  db: store,
  pluginSkills,
};

const bus = new RunEventBus();
const launcher = new InProcessLauncher(engineConfig, store, runsDir, bus);
```

**Add `EngineConfig` to the import from `@studio/engine`:**
```typescript
import {
  PipelineEngine,    // ← remove this
  EngineConfig,      // ← keep this
  SQLiteRunStore,
  type RunStore,
} from '@studio/engine';
```

Actually remove `PipelineEngine` from the import since bootstrap no longer instantiates it directly.

### Step 2: Typecheck

```bash
pnpm --filter @studio/api typecheck
```

Expected: no errors.

### Step 3: Commit

```bash
git add api/src/bootstrap.ts
git commit -m "refactor(api): bootstrap passes EngineConfig + RunEventBus to launcher"
```

---

## Task 4: SSE Route + replayJsonl

**Files:**
- Create: `api/tests/sse.test.ts`
- Modify: `api/src/routes/runs.ts`

### Step 1: Write the failing SSE tests

`api/tests/sse.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio/engine';
import { RunEventBus } from '../src/event-bus.js';
import type { RunLauncher } from '../src/launcher.js';

const TMP = resolve('/tmp', `studio-sse-test-${Date.now()}`);
mkdirSync(TMP, { recursive: true });

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

function makeDeps(overrides?: Partial<{
  runExists: boolean;
  runStatus: string;
  logPath: string | null;
}>) {
  const { runExists = false, runStatus = 'running', logPath = null } = overrides ?? {};

  const store = new InMemoryRunStore();
  if (runExists) {
    // Manually seed a run record via saveLogPath (store allows this as side effect)
    // We'll use a simpler approach: mock the store methods
  }

  const mockStore = {
    getPipelineRun: vi.fn().mockReturnValue(
      runExists
        ? { id: 'run-1', pipeline_name: 'p', status: runStatus, started_at: '', stages: [] }
        : null
    ),
    getLogPath: vi.fn().mockReturnValue(logPath),
    saveLogPath: vi.fn(),
    listPipelineRuns: vi.fn().mockReturnValue([]),
    savePipelineRun: vi.fn(),
    updatePipelineRun: vi.fn(),
    saveStageRun: vi.fn(),
    saveTaskRun: vi.fn(),
  };

  const mockLauncher: RunLauncher = {
    launch: vi.fn().mockResolvedValue({ run_id: 'run-1' }),
    cancel: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };

  return { mockStore, mockLauncher };
}

describe('GET /api/runs/:id/stream', () => {
  it('returns 404 for unknown run', async () => {
    const { mockStore, mockLauncher } = makeDeps({ runExists: false });
    const fastify = buildServer({
      store: mockStore as never,
      launcher: mockLauncher,
      configsDir: TMP,
      projectName: 'test',
      apiConfig: {},
    });

    const res = await fastify.inject({ method: 'GET', url: '/api/runs/unknown-id/stream' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Run not found' });
  });

  it('replays JSONL history and closes for a terminated run', async () => {
    const logFile = resolve(TMP, 'run.jsonl');
    writeFileSync(logFile, [
      JSON.stringify({ ts: '2026-01-01', run_id: 'r1', event: 'stage_complete', stage_name: 'brief-analysis', status: 'success' }),
      JSON.stringify({ ts: '2026-01-01', run_id: 'r1', event: 'pipeline_complete', status: 'success' }),
    ].join('\n') + '\n');

    const { mockStore, mockLauncher } = makeDeps({
      runExists: true,
      runStatus: 'success',
      logPath: logFile,
    });

    const fastify = buildServer({
      store: mockStore as never,
      launcher: mockLauncher,
      configsDir: TMP,
      projectName: 'test',
      apiConfig: {},
    });

    const res = await fastify.inject({ method: 'GET', url: '/api/runs/run-1/stream' });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: stage_complete');
    expect(res.body).toContain('event: pipeline_complete');
  });

  it('filters events by ?events= query param', async () => {
    const logFile = resolve(TMP, 'run-filter.jsonl');
    writeFileSync(logFile, [
      JSON.stringify({ ts: '2026-01-01', run_id: 'r1', event: 'stage_complete', stage_name: 's1' }),
      JSON.stringify({ ts: '2026-01-01', run_id: 'r1', event: 'pipeline_complete', status: 'success' }),
    ].join('\n') + '\n');

    const { mockStore, mockLauncher } = makeDeps({
      runExists: true,
      runStatus: 'success',
      logPath: logFile,
    });

    const fastify = buildServer({
      store: mockStore as never,
      launcher: mockLauncher,
      configsDir: TMP,
      projectName: 'test',
      apiConfig: {},
    });

    const res = await fastify.inject({
      method: 'GET',
      url: '/api/runs/run-1/stream?events=pipeline_complete',
    });

    expect(res.body).not.toContain('event: stage_complete');
    expect(res.body).toContain('event: pipeline_complete');
  });
});
```

### Step 2: Run — verify FAIL

```bash
pnpm --filter @studio/api test sse
```

Expected: `404 for unknown run` passes (route doesn't exist yet → Fastify returns 404). Other tests fail because there's no SSE route. That's fine — all three may fail.

### Step 3: Add replayJsonl + SSE route to `api/src/routes/runs.ts`

Add at the top of `runs.ts` (with existing imports):
```typescript
import { readFile } from 'node:fs/promises';
```
(already imported — confirm it's there)

Add `replayJsonl` helper after the existing imports:

```typescript
async function replayJsonl(
  logPath: string,
  send: (type: string, data: unknown) => void,
): Promise<void> {
  let content: string;
  try {
    content = await readFile(logPath, 'utf-8');
  } catch {
    return; // log not yet written or missing
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { event?: string } & Record<string, unknown>;
      if (parsed.event) send(parsed.event, parsed);
    } catch {
      // skip malformed lines
    }
  }
}
```

Add the SSE route inside `runsRoutes`, after the existing `GET /runs/:id/logs` route:

```typescript
// GET /api/runs/:id/stream — SSE
fastify.get<{
  Params: { id: string };
  Querystring: { events?: string };
}>('/runs/:id/stream', {
  schema: {
    querystring: {
      type: 'object',
      properties: { events: { type: 'string' } },
    },
  },
}, async (request, reply) => {
  const { id } = request.params;
  const filterParam = request.query.events;
  const filter = filterParam ? filterParam.split(',') : null;

  const run = store.getPipelineRun(id);
  if (!run) {
    return reply.status(404).send({ error: 'Run not found' });
  }

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const send = (type: string, data: unknown) => {
    if (filter && !filter.includes(type)) return;
    reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Replay historical events from JSONL
  const logPath = store.getLogPath(id);
  if (logPath) await replayJsonl(logPath, send);

  const TERMINAL = ['success', 'failed', 'rejected', 'cancelled'];
  if (TERMINAL.includes(run.status)) {
    reply.raw.end();
    return reply;
  }

  // Subscribe to live events
  const unsub = options.deps.launcher.subscribe(id, ({ type, data }) => send(type, data));

  // Cleanup on client disconnect
  request.raw.on('close', unsub);

  // Keep connection open — Fastify won't auto-close since we used reply.raw
  return reply;
});
```

### Step 4: Run — verify PASS

```bash
pnpm --filter @studio/api test sse
```

Expected: all 3 SSE tests pass.

### Step 5: Commit

```bash
git add api/src/routes/runs.ts api/tests/sse.test.ts
git commit -m "feat(api): add GET /api/runs/:id/stream SSE endpoint"
```

---

## Task 5: Full build + all tests

### Step 1: Run all API tests

```bash
pnpm --filter @studio/api test
```

Expected: all tests pass (event-bus, launcher, sse, existing server tests).

### Step 2: Build

```bash
pnpm build
```

Expected: no TypeScript errors across all packages.

### Step 3: Commit if any fixes were needed

```bash
git add -p
git commit -m "fix(api): typecheck fixes after SSE implementation"
```

Only commit if there were actual fixes. Skip otherwise.

---

## Task 6: Manual smoke test (optional)

If a mock provider is configured:

```bash
# Terminal 1 — start API
cd /path/to/project-with-.studio/
studio api start

# Terminal 2 — launch a run
curl -X POST http://localhost:3700/api/runs \
  -H "Content-Type: application/json" \
  -d '{"pipeline":"feature-builder","input":{"brief_summary":"test"}}'
# → {"run_id":"abc123","stream_url":"/api/runs/abc123/stream"}

# Terminal 3 — stream events
curl -N http://localhost:3700/api/runs/abc123/stream
# → event: stage_start
#   data: {...}
# → event: stage_complete
#   data: {...}
```

---

## Checklist

- [ ] `RunEventBus` — unit tested, isolated by run_id
- [ ] `InProcessLauncher` — per-run engine factory, subscribe() works
- [ ] `bootstrap.ts` — passes `EngineConfig` + bus to launcher
- [ ] `GET /api/runs/:id/stream` — 404, replay, filter, live subscribe
- [ ] `pnpm build` passes
- [ ] Branch: `feat/stu-23-sse` off `feat/stu-22-api`
