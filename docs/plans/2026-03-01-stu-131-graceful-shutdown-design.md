# STU-131 — Graceful Shutdown During Active LLM Stream

**Date:** 2026-03-01
**Issue:** [STU-131](https://linear.app/studioag/issue/STU-131)
**Priority:** High — v0.3.0

---

## Problem

Ctrl-C works correctly between stages, but if the signal fires while a stage is actively streaming from the LLM, the pipeline hangs indefinitely — even with multiple Ctrl-C presses.

**Root cause (Anthropic):** `stream.finalMessage()` waits for an `end` event on the stream. When the underlying HTTP fetch is aborted mid-stream, the connection closes without emitting `end`, so `finalMessage()` hangs forever. The signal is never checked again, so ralph never returns `cancelled`.

**Root cause (OpenAI):** The `for await (const chunk of stream)` loop has no per-chunk signal check. Buffered network data continues processing even after abort.

Both providers already receive `signal` in their call signatures — the fix is purely about what happens *during* an active stream.

---

## Non-goals

- No changes to ralph, engine, or CLI — the cancellation propagation chain is already correct.
- No changes to file write atomicity — tool calls run to completion before any signal check, so no partial writes.
- The LLM connection may drain briefly in the background after the race bails out (Anthropic path). This is acceptable — no user-visible impact.

---

## Design

### `raceSignal()` utility

New file: `runner/src/utils/race-signal.ts`

Races any promise against an AbortSignal. Rejects with `DOMException('Aborted', 'AbortError')` the moment the signal fires. Cleans up the event listener on both resolve and reject paths.

```typescript
export function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });

    promise
      .then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); })
      .catch((e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}
```

### Anthropic provider (`runner/src/providers/anthropic.ts`)

Two changes in the streaming path:

1. Guard `onToken` against post-abort emission (signal already fired but event queue still has a buffered chunk).
2. Race `stream.finalMessage()` with the signal — this is the key fix that unblocks the hang.

```typescript
if (onToken) {
  const stream = this.client.messages.stream(params, { signal });
  stream.on('text', (textDelta: string) => {
    if (signal?.aborted) return;   // guard: don't emit after abort
    onToken(textDelta);
  });
  const response = await raceSignal(stream.finalMessage(), signal);  // KEY FIX
  return this.parseResponse(response);
}
// Non-streaming path unchanged — signal already correctly passed to SDK
```

### OpenAI provider (`runner/src/providers/openai.ts`)

Add a per-chunk signal check at the top of the `for await` loop:

```typescript
for await (const chunk of stream) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');  // KEY FIX
  // ... rest unchanged
}
```

### Error propagation (no changes needed)

Once a provider throws, cancellation flows correctly through the existing stack:

```
provider throws DOMException('AbortError')
  → runner.ts propagates (no try/catch around provider.call)
  → ralph loop.ts:58-62: catches, checks signal?.aborted → { status: 'cancelled' }
  → engine: deriveStageStatus('cancelled') → stage.status = 'cancelled'
  → engine: emits onPipelineCancelled + onPipelineComplete(status: 'cancelled')
  → engine: savePipelineRun (DB)
  → JSONL logger: writes pipeline_complete event  ✓
```

---

## Acceptance criteria

| Criterion | How met |
|-----------|---------|
| Ctrl-C during LLM stream stops in 1–2s | `raceSignal()` resolves in next microtask after signal fires |
| Run ends with status `cancelled` | Existing ralph→engine path, no changes |
| `pipeline_complete` logged in JSONL | Already emitted in all cancel paths in engine.ts |
| No partial file writes | Tool calls always run to completion; signal check is next LLM call |

---

## Files to change

| File | Change |
|------|--------|
| `runner/src/utils/race-signal.ts` | **New** — `raceSignal()` utility |
| `runner/src/providers/anthropic.ts` | Guard `onToken` + race `finalMessage()` |
| `runner/src/providers/openai.ts` | Per-chunk signal check in `for await` loop |
| `runner/src/providers/anthropic.test.ts` | Tests: signal mid-stream → AbortError < 100ms |
| `runner/src/providers/openai.test.ts` | Tests: signal mid-iteration → AbortError |

Total: ~30 lines of new/changed code across 2 production files + 1 new utility.

---

## Out of scope

- STU-25 (cancel via API) — will benefit from this fix automatically, separate ticket.
- Mock provider — no streaming, not affected.
- OpenAI Responses API provider — uses `runAgentLoop` (agent loop path), separate code path, out of scope.
