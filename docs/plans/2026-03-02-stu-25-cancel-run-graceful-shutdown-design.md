# STU-25 — Cancel Run: Graceful Shutdown (Design)

**Date:** 2026-03-02
**Status:** Approved
**Scope:** Approach A — Patch & test

---

## Context

STU-25 specifies graceful run cancellation via `DELETE /runs/:id` (API) and `Ctrl+C` (CLI). Most of the implementation was completed as a byproduct of STU-131 (graceful shutdown during active LLM stream, PR #103). Four gaps remain.

---

## What's Already Done

| Component | Location |
|---|---|
| `StageStatus: 'cancelled'` | `contracts/src/stage.ts` |
| Ralph loop `AbortSignal` checks | `ralph/src/loop.ts` |
| `deriveStageStatus('cancelled')` | `engine/src/state/status-derivation.ts` |
| Engine: signal check before each stage, handles cancelled | `engine/src/engine.ts` |
| Engine: emits `onPipelineCancelled` | `engine/src/engine.ts` |
| CLI: `SIGINT`/`SIGTERM` → `AbortController.abort()` + exit 130 | `cli/src/commands/run.ts` |
| `POST /api/runs/:id/cancel` endpoint | `api/src/routes/runs.ts` |
| `InProcessLauncher.cancel(runId)` | `api/src/launcher.ts` |
| Tests: ralph (4), API cancel (4), launcher cancel (2), engine basic (1) | various |

---

## Four Gaps to Fix

### 1. SSE Double-Close Bug

**File:** `api/src/launcher.ts`

**Problem:** The engine always emits `onPipelineCancelled` followed immediately by `onPipelineComplete` for cancelled runs. The launcher's `onPipelineCancelled` handler calls `this.bus.close(runId)`, which deletes all SSE subscribers. When `onPipelineComplete` fires, there are no subscribers — the final `pipeline_complete` event is lost. SSE clients never receive the terminal event for cancelled runs.

**Fix:** Remove `this.bus.close(runId)` from `onPipelineCancelled`. The bus is already closed by `onPipelineComplete` (which always fires right after for all terminal states).

```typescript
// Before
onPipelineCancelled: (e) => {
  emit('pipeline_cancelled', e);
  this.bus.close(runId);  // ← remove
},

// After
onPipelineCancelled: (e) => {
  emit('pipeline_cancelled', e);
},
```

**Tests:** Add to `api/tests/cancel.test.ts` — verify SSE receives both `pipeline_cancelled` and `pipeline_complete` for a cancelled run (requires mocking engine events in sequence).

---

### 2. `DELETE /api/runs/:id` Endpoint

**File:** `api/src/routes/runs.ts`

**Spec alignment:** The STU-25 spec says `DELETE /api/runs/:id`. The existing `POST /api/runs/:id/cancel` stays as-is (backwards compat). `DELETE` is added as an additional route with identical semantics.

```
DELETE /api/runs/:id
  → 200 { run_id }    — run was running and cancel was requested
  → 404 { error }     — run not found
  → 409 { error }     — run not cancellable (already terminal)
```

Full Swagger schema required per CLAUDE.md conventions.

**Tests:** Add 3 tests to `api/tests/cancel.test.ts` mirroring the existing POST tests:
- `DELETE /api/runs/:id` returns 200 for running run
- `DELETE /api/runs/:id` returns 404 for unknown run
- `DELETE /api/runs/:id` returns 409 for terminal run

---

### 3. State Machine `'cancel'` Transition

**File:** `engine/src/state/state-machine.ts`

Cancellation currently bypasses `transition()` by directly setting `stageRun.status = 'cancelled'`. Adding the transition makes cancellation consistent with all other state changes.

```typescript
// Add to VALID_TRANSITIONS:
'running:cancel': 'cancelled',

// Add to StageEvent union:
type StageEvent = 'start' | 'succeed' | 'fail' | 'skip' | 'reject' | 'cancel';
```

**File:** `engine/src/engine.ts`

Replace the 3 direct `stageRun.status = 'cancelled'` assignments with `transition('running', 'cancel')`. Note: the `stageRun` at cancellation time is always in state `'running'`, so the transition is valid.

---

### 4. Missing Engine Tests (3 new tests)

**File:** `engine/tests/unit/engine.test.ts`

**Test A — Signal aborted while a stage is running:**
Mock executor that delays 1 tick, abort the signal during that tick. Verify `result.status === 'cancelled'` and no stages have `status: 'success'`.

**Test B — Signal aborted between stages:**
Two-stage pipeline. After stage 1 succeeds, abort the signal (using `onStageComplete` event callback). Verify `result.status === 'cancelled'`, `result.stages[0].status === 'success'`, and stage 2 was never started.

**Test C — Signal aborted during a group iteration:**
Pipeline with a group containing 2 stages. Abort signal while stage 1 of the group is running. Verify pipeline cancels cleanly.

---

## Files Changed

| File | Change |
|---|---|
| `api/src/launcher.ts` | Remove `bus.close` from `onPipelineCancelled` |
| `api/src/routes/runs.ts` | Add `DELETE /api/runs/:id` route |
| `api/tests/cancel.test.ts` | 3 new tests for DELETE + SSE event order |
| `engine/src/state/state-machine.ts` | Add `'running:cancel': 'cancelled'` transition |
| `engine/src/engine.ts` | Use `transition('running', 'cancel')` in 3 spots |
| `engine/tests/unit/engine.test.ts` | 3 new cancellation tests (A, B, C) |

---

## Out of Scope

- Replacing `POST /api/runs/:id/cancel` (kept for backwards compat)
- Audit of parallel group cancellation paths (already works — parallel group uses `Promise.allSettled` which doesn't cancel)
- Script stage cancellation (scripts run to completion, no AbortSignal propagation — acceptable limitation)
