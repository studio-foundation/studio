# STU-20 Wire SQLite Run Store — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire `SQLiteRunStore` into `studio run` so every pipeline execution is persisted to SQLite, making `studio status` read from SQLite without needing the JSONL fallback.

**Architecture:** Create a shared `createRunStore(config)` factory in the CLI that derives the DB path from `StudioConfig.resolvedStudioDir`. Both `run.ts` and `status.ts` use the factory so they always point to the same DB. The engine already has a `db?: RunStore` injection point — we just never passed it.

**Tech Stack:** TypeScript, `better-sqlite3` (via existing `SQLiteRunStore`), vitest

---

## Task 1: Add `close?()` to the `RunStore` interface

The `SQLiteRunStore` already has a `close()` method but the shared `RunStore` interface doesn't declare it. Callers need to call it to release the DB file handle. Adding it as optional (`close?(): void`) is backward-compatible — `InMemoryRunStore` simply doesn't implement it.

**Files:**
- Modify: `engine/src/state/run-store.ts`

**Step 1: Add `close?()` to the interface**

Open `engine/src/state/run-store.ts` and add one line to the `RunStore` interface:

```typescript
export interface RunStore {
  savePipelineRun(run: PipelineRun): void;
  getPipelineRun(id: string): PipelineRun | null;
  listPipelineRuns(options?: { limit?: number; status?: string }): PipelineRun[];
  getLatestRun(pipelineName?: string): PipelineRun | null;
  saveLogPath(runId: string, logPath: string): void;
  getLogPath(runId: string): string | null;
  close?(): void;   // ← add this line
}
```

`SQLiteRunStore` already has `close(): void` as a non-optional method — it satisfies this interface. `InMemoryRunStore` has no `close()` — that's fine, it's optional.

**Step 2: Typecheck engine**

```bash
pnpm --filter @studio-foundation/engine typecheck
```

Expected: no errors.

**Step 3: Build engine**

```bash
pnpm --filter @studio-foundation/engine build
```

Expected: exits 0.

**Step 4: Commit**

```bash
git add engine/src/state/run-store.ts
git commit -m "feat(engine): add optional close() to RunStore interface"
```

---

## Task 2: Create `run-store-factory.ts` (TDD)

The factory takes a `StudioConfig` and returns a `RunStore`. It derives the SQLite path from `config.resolvedStudioDir`, falling back to `<cwd>/.studio` if the field is absent. This is the single place to swap out the adapter later.

**Files:**
- Create test: `cli/src/run-store-factory.test.ts`
- Create impl: `cli/src/run-store-factory.ts`

**Step 1: Write the failing test**

Create `cli/src/run-store-factory.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { createRunStore } from './run-store-factory.js';
import type { PipelineRun } from '@studio-foundation/contracts';

const tmpDir = `/tmp/.studio-factory-test-${Date.now()}`;

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('createRunStore', () => {
  it('returns a RunStore that can round-trip a PipelineRun', () => {
    const store = createRunStore({ resolvedStudioDir: tmpDir });

    const run: PipelineRun = {
      id: 'abc-123',
      pipeline_name: 'test-pipeline',
      status: 'success',
      started_at: '2026-01-01T00:00:00.000Z',
      stages: [],
    };

    store.savePipelineRun(run);
    const retrieved = store.getPipelineRun('abc-123');

    expect(retrieved?.id).toBe('abc-123');
    expect(retrieved?.pipeline_name).toBe('test-pipeline');
    expect(retrieved?.status).toBe('success');

    store.close?.();
  });

  it('saves and retrieves log path', () => {
    const store = createRunStore({ resolvedStudioDir: tmpDir });

    const run: PipelineRun = {
      id: 'log-run',
      pipeline_name: 'p',
      status: 'success',
      started_at: '2026-01-01T00:00:00.000Z',
      stages: [],
    };
    store.savePipelineRun(run);
    store.saveLogPath('log-run', '/tmp/some.jsonl');

    expect(store.getLogPath('log-run')).toBe('/tmp/some.jsonl');

    store.close?.();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @studio-foundation/cli test
```

Expected: FAIL — `run-store-factory.ts` does not exist yet.

**Step 3: Implement the factory**

Create `cli/src/run-store-factory.ts`:

```typescript
import { join } from 'node:path';
import type { StudioConfig } from './config.js';
import { SQLiteRunStore } from '@studio-foundation/engine';
import type { RunStore } from '@studio-foundation/engine';

/**
 * Create the production RunStore from config.
 * Derives the SQLite path from config.resolvedStudioDir.
 * Future: read config.db.adapter to return PostgreSQL/Supabase store instead.
 */
export function createRunStore(config: StudioConfig): RunStore {
  const studioDir = config.resolvedStudioDir ?? join(process.cwd(), '.studio');
  const dbPath = join(studioDir, 'runs.db');
  return new SQLiteRunStore(dbPath);
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm --filter @studio-foundation/cli test
```

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add cli/src/run-store-factory.ts cli/src/run-store-factory.test.ts
git commit -m "feat(cli): add createRunStore factory"
```

---

## Task 3: Update `status.ts` to use the factory

Currently `status.ts` hardcodes `new SQLiteRunStore(resolve(process.cwd(), '.studio/runs.db'))`. Replace with the factory so it's always in sync with `run.ts`.

**Files:**
- Modify: `cli/src/commands/status.ts`

**Step 1: Load config and use the factory**

Replace the top of `statusCommand()` in `cli/src/commands/status.ts`.

Remove these lines:
```typescript
const DEFAULT_DB_PATH = resolve(process.cwd(), '.studio/runs.db');
```

And update the imports to add:
```typescript
import { loadConfig } from '../config.js';
import { createRunStore } from '../run-store-factory.js';
```

Replace the SQLite block inside `statusCommand()`:

Before:
```typescript
let run: PipelineRun | null = null;
try {
  const store = new SQLiteRunStore(DEFAULT_DB_PATH);
  run = runId ? store.getPipelineRun(runId) : store.getLatestRun();
} catch {
  // DB not available or not initialized
}
```

After:
```typescript
let run: PipelineRun | null = null;
try {
  const config = await loadConfig();
  const store = createRunStore(config);
  run = runId ? store.getPipelineRun(runId) : store.getLatestRun();
  store.close?.();
} catch {
  // DB not available or not initialized
}
```

Also remove the unused `SQLiteRunStore` import from `@studio-foundation/engine` if it becomes unused (check the import at the top of `status.ts`).

**Step 2: Typecheck**

```bash
pnpm --filter @studio-foundation/cli typecheck
```

Expected: no errors.

**Step 3: Commit**

```bash
git add cli/src/commands/status.ts
git commit -m "feat(cli): use createRunStore factory in status command"
```

---

## Task 4: Update `run.ts` to wire the store into the engine

This is the core of STU-20. `run.ts` creates `PipelineEngine` but never passes `db`. We add store creation (fail-silent), pass `db`, save the log path after the run completes, and close the store in `finally`.

**Files:**
- Modify: `cli/src/commands/run.ts`

**Step 1: Add the import**

At the top of `cli/src/commands/run.ts`, add:

```typescript
import { createRunStore } from '../run-store-factory.js';
import type { RunStore } from '@studio-foundation/engine';
```

**Step 2: Create the store (fail-silent) before the engine**

In `runCommand()`, after `loadConfig()` and before creating the engine, add:

```typescript
// Create run store — fail-silent so a broken SQLite never blocks a run
let runStore: RunStore | null = null;
try {
  runStore = createRunStore(config);
} catch {
  // Non-fatal: run proceeds with JSONL logging only
}
```

**Step 3: Pass `db` to the engine**

Find the `new PipelineEngine(...)` call and add `db`:

```typescript
const engine = new PipelineEngine(
  {
    configsDir,
    repoPath,
    providerRegistry,
    toolRegistry,
    pluginSkills,
    db: runStore ?? undefined,          // ← add this line
    ...(options.provider ? { providerOverride: options.provider } : {}),
  },
  events
);
```

**Step 4: Save log path and close in `finally`**

The `finally` block currently has:
```typescript
} finally {
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onInterrupt);
  await runLogger.close();
  await Promise.allSettled(mcpClients.map((c) => c.close()));
}
```

Add the store cleanup after `runLogger.close()`:
```typescript
} finally {
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onInterrupt);
  await runLogger.close();
  if (runStore && result) {
    runStore.saveLogPath(result.id, runLogger.getLogPath());
  }
  runStore?.close?.();
  await Promise.allSettled(mcpClients.map((c) => c.close()));
}
```

Note: `result` is declared with `let result;` before the try block and assigned inside it (`result = await engine.run(...)`). The `saveLogPath` only runs if the engine produced a result (i.e., not an exception before `engine.run()`).

**Step 5: Typecheck**

```bash
pnpm --filter @studio-foundation/cli typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add cli/src/commands/run.ts
git commit -m "feat(cli): wire SQLiteRunStore into studio run (STU-20)"
```

---

## Task 5: Build everything and run all tests

**Step 1: Full build**

```bash
pnpm build
```

Expected: exits 0, all 5 packages build in dependency order.

**Step 2: Run all tests**

```bash
pnpm test
```

Expected: all tests pass including the new `run-store-factory.test.ts`.

**Step 3: Smoke test (optional, requires a project with `.studio/`)**

If you have a local project with `.studio/`, verify end-to-end:

```bash
# In a project that has .studio/
studio run <some-pipeline> --provider mock --input "test"
studio status
```

Expected: `studio status` shows the run from SQLite (no JSONL parsing needed).

**Step 4: Final commit (if build fixed anything)**

If step 1 or 2 required any fixes, commit them now.

---

## Acceptance Criteria Checklist

- [ ] `studio run` writes run metadata to `<studioDir>/runs.db` at every run
- [ ] `studio status` reads from SQLite via the factory (consistent path)
- [ ] JSONL fallback remains in `status.ts` for old runs
- [ ] `createRunStore` factory is the single place to swap backends
- [ ] All tests pass (`pnpm test`)
- [ ] `pnpm build` passes
