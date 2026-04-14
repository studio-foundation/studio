# Design: STU-20 — Wire SQLite in `studio run`

## Context

`studio run` never writes to SQLite. `SQLiteRunStore` is fully implemented in `engine/src/state/run-store.ts` and the `PipelineEngine` already accepts a `db?: RunStore` injection point and calls `db.savePipelineRun()` at every completion point — but `cli/src/commands/run.ts` never passes one. So every write is a no-op and `studio status` always falls back to JSONL parsing.

Blocks STU-22 (API reads from SQLite).

## Decision

**Approach B — shared `createRunStore()` factory** (vs. inline instantiation at each call site).

Rationale:
- `RunStore` is already an abstract interface designed for future adapters (PostgreSQL, Supabase).
- Two callers exist today (`run.ts` and `status.ts`). Inlining SQLite construction in both means touching both when swapping adapters.
- `status.ts` currently hardcodes `resolve(process.cwd(), '.studio/runs.db')`. `run.ts` computes `configsDir` from `config.resolvedStudioDir`. A factory derives the path once from `StudioConfig`, eliminating drift between callers.

## Components

### 1. `cli/src/run-store-factory.ts` (new)

```ts
import { join } from 'node:path';
import type { StudioConfig } from './config.js';
import type { RunStore } from '@studio-foundation/engine';
import { SQLiteRunStore } from '@studio-foundation/engine';

export function createRunStore(config: StudioConfig): RunStore {
  const studioDir = config.resolvedStudioDir ?? join(process.cwd(), '.studio');
  const dbPath = join(studioDir, 'runs.db');
  return new SQLiteRunStore(dbPath);
}
```

Future: reads `config.db?.adapter` to pick alternate backends. No config key needed yet.

### 2. `cli/src/commands/run.ts`

- After `loadConfig()`, call `createRunStore(config)` wrapped in try/catch (non-fatal if SQLite init fails — run continues with JSONL only).
- Pass `db: runStore` to `PipelineEngine`.
- In the `finally` block: call `runStore.saveLogPath(result.id, runLogger.getLogPath())` then `runStore.close()`.

### 3. `cli/src/commands/status.ts`

- Replace inline `new SQLiteRunStore(DEFAULT_DB_PATH)` with `createRunStore(config)` (requires loading config first).
- JSONL fallback stays unchanged — handles old runs and the SQLite-unavailable case.

## Data flow after this change

```
studio run
  → writes JSONL (events, tool calls, outputs)   ← studio logs
  → writes SQLite (metadata, status, log_path)   ← studio status, API
```

## Acceptance criteria

| Criterion | Mechanism |
|---|---|
| `studio run` writes to SQLite | `db: runStore` passed to `PipelineEngine` |
| `studio status` reads from SQLite (no JSONL fallback triggered for new runs) | factory gives consistent path; SQLite record found first |
| JSONL fallback kept for old runs | unchanged in `status.ts` |
| Config-driven store selection possible | factory is the single swap point |
| Path consistency between callers | both use `createRunStore(config)` |

## Out of scope

- No new config keys for adapter selection
- No schema changes to `SQLiteRunStore`
- No changes to `engine/` (injection point already exists)
