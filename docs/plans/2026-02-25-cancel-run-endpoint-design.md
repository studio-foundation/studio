# Design: POST /api/runs/:id/cancel (STU-145)

## Problem

Once a run is launched, there is no way to stop it via the API. If a pipeline loops or exceeds token budget, the only option is to kill the process manually. This is a blocker for real clients and any web interface.

## Solution

Add `POST /api/runs/:id/cancel` to `@studio-foundation/api`. The route sends an abort signal to the in-process engine and returns immediately — consistent with the fire-and-forget pattern already used by `POST /runs`.

## Approach chosen: Pure route addition

All cancellation infrastructure already exists:
- `InProcessLauncher.cancel(run_id)` — calls `AbortController.abort()`
- `StageStatus` includes `'cancelled'`
- `PipelineCancelledEvent` is defined and emitted by the engine
- `SseEventType` includes `'pipeline_cancelled'`
- The engine detects `signal.aborted` between stages, sets status to `'cancelled'`, and persists to SQLite

No engine, launcher, contracts, or store changes needed.

## Route spec

```
POST /api/runs/:id/cancel
```

| Case | Status | Body |
|------|--------|------|
| Run is `running` | 200 | `{ run_id }` |
| Run not found | 404 | `{ error: "Run not found" }` |
| Run not in `running` state | 409 | `{ error: "Run is not cancellable (status: <status>)" }` |

## Handler logic

```
1. store.getPipelineRun(id)    → null → 404
2. run.status !== 'running'    → 409
3. launcher.cancel(id)         → sends AbortSignal (resolves immediately)
4. reply 200 { run_id: id }
```

## What happens after the signal

The engine checks `signal.aborted` between stages (and passes it into ralph and runAgent for mid-call abort). When detected, it:
1. Sets `pipelineRun.status = 'cancelled'`
2. Calls `onPipelineCancelled` → launcher emits `pipeline_cancelled` on the event bus
3. Calls `db.savePipelineRun()` → SQLite updated
4. Bus closes → SSE stream ends with `pipeline_cancelled` event

The HTTP response returns before this completes. Clients use `GET /api/runs/:id` to poll or `GET /api/runs/:id/stream` (SSE) for real-time confirmation.

## Side fix

`pipelineRunSchema.status.enum` in `runs.ts` is missing `'cancelled'`. Fix in the same PR since the store can already return runs with that status.

## Tests

New file `api/tests/cancel.test.ts`:

1. `200` — running run → returns `{ run_id }`, `launcher.cancel` called once
2. `404` — unknown run_id
3. `409` — run already in terminal state (`success`, `failed`, `cancelled`)

## Files changed

- `api/src/routes/runs.ts` — new route + enum fix
- `api/tests/cancel.test.ts` — new test file
