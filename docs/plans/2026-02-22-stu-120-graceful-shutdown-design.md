# STU-120: Graceful Shutdown via AbortController

**Date:** 2026-02-22
**Issue:** [STU-120](https://linear.app/studioag/issue/STU-120)
**Status:** Approved
**Packages:** contracts, ralph, runner, engine, cli

## Problem

Ctrl-C during `studio run` does nothing useful. The pipeline continues, LLM calls keep burning tokens, and there's no way to stop a run gone wrong. The existing SIGINT handler in the CLI only flushes logs and hard-exits — the engine, ralph, runner, and providers have zero cancellation awareness.

## Approach: AbortController threading

Pass a standard `AbortSignal` from the CLI down through every layer: engine → ralph → runner → provider. Each layer checks `signal.aborted` at its natural checkpoints. Two-phase Ctrl-C: first press triggers cooperative shutdown, second press force-kills.

## New status: `cancelled`

```typescript
type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'rejected' | 'cancelled';
```

Semantically distinct from `failed` — the user chose to stop, nothing went wrong. `PipelineRun.status` also gains `'cancelled'`.

## Signal flow

```
CLI (AbortController)
 │
 │  signal
 ▼
engine.run(input, { signal })
 │  checks signal.aborted before each stage/group iteration
 │
 ├─► ralph({ ..., signal })
 │    checks signal.aborted before each retry attempt
 │    if aborted → returns { status: 'cancelled' }
 │
 └─► runAgent({ ..., signal })
      checks signal.aborted before each tool-call iteration
      │
      └─► provider.call(request, onToken, { signal })
           passes signal to Anthropic/OpenAI SDK
           SDK aborts the HTTP request → throws AbortError
```

## Package-by-package changes

### contracts

- Add `'cancelled'` to `StageStatus` type union.

### ralph

- `RalphConfig<T>` gains optional `signal?: AbortSignal`.
- `RalphResult<T>` gains a new variant: `{ status: 'cancelled'; lastResult?: T; attempts: number }`.
- The loop checks `signal?.aborted` at the top of each iteration before calling `executor`. If aborted, returns `{ status: 'cancelled' }`.
- The retry delay `setTimeout` is wired to the signal so it resolves immediately on abort.
- If `executor` throws an `AbortError` (from the provider), ralph checks `signal?.aborted` and returns `cancelled` instead of treating it as a validation failure.

### runner

- `RunAgentConfig` gains optional `signal?: AbortSignal`.
- `runAgent()` checks `signal?.aborted` before each LLM call in the multi-turn tool loop.
- Signal is forwarded to `provider.call()`.
- `Provider` interface: `call(request, onToken?, signal?)`.
- `AgentLoopProvider.runAgentLoop()`: gains optional `signal?` parameter.

### runner/providers

Each provider passes `signal` to the SDK:
- **Anthropic:** `this.client.messages.stream(params, { signal })` and `this.client.messages.create(params, { signal })`.
- **OpenAI:** passes `signal` in the create options for both streaming and non-streaming paths.
- **OpenAI Responses:** passes `signal` to the responses API call.
- **Mock:** no change needed (already instant).

### engine

- `RunInput` gains optional `signal?: AbortSignal`.
- `PipelineEngine.run()` checks `signal?.aborted` before each pipeline entry in the main `for` loop.
- Passes `signal` to `ralph()` calls and through to `runAgent()`.
- `deriveStageStatus()` maps ralph `'cancelled'` → stage `'cancelled'`.
- On cancellation: persists run with `status: 'cancelled'`, emits `onPipelineComplete` with that status.
- New event: `onPipelineCancelled?: (event: { run_id: string; cancelled_at_stage: string }) => void`.

### cli

Rewrites the SIGINT handler in `run.ts`:

**First Ctrl-C:**
1. `controller.abort()` — signals everything to stop cooperatively.
2. Print `⚠ Cancelling run {id}...`
3. Wait for `engine.run()` promise to settle (it will, because everything checks the signal).
4. `engine.run()` returns `PipelineRun` with `status: 'cancelled'`.
5. Normal cleanup: flush logs, close MCP clients.
6. Print `✗ Run cancelled at stage [N/T] <stage-name>`.
7. `process.exit(130)`.

**Second Ctrl-C (while waiting):**
`process.exit(130)` immediately.

## Error discrimination

When a provider throws because of an aborted signal, it throws an `AbortError` (standard DOM error name). Ralph catches executor throws — but instead of counting it as a validation failure, it checks `signal?.aborted` and returns `{ status: 'cancelled' }` cleanly.

Key rule: **ralph never retries after abort.**

## Edge cases

| Scenario | Behavior |
|----------|----------|
| Ctrl-C during `on_pipeline_start` commands | Commands have timeouts. Signal checked after each. Pipeline marked cancelled. |
| Ctrl-C during hook execution | Hook finishes (short-lived with timeout). Signal checked after. Stage marked cancelled. |
| Ctrl-C during ralph retry delay | `setTimeout` resolves immediately via signal listener. Ralph returns cancelled. |
| Ctrl-C between stages | Engine catches it at loop top, skips remaining stages, marks cancelled. |
| Ctrl-C during group iteration | Group loop checks signal, exits, marks cancelled. |
| LLM provider doesn't support abort | Provider throws generic error. Ralph sees signal is aborted, returns cancelled anyway. |

## What does NOT change

- Tool execution timeouts (managed by `child_process`).
- Hook execution (short-lived, don't need abort).
- Run store schema (status is already a TEXT column).
- JSONL logging (`runLogger.close()` flush logic unchanged).
- Contract validation.

## Acceptance criteria (from issue)

- [x] Ctrl-C interrupts the run immediately (no hang)
- [x] Run is marked `cancelled` in the DB (not `failed`)
- [x] In-flight LLM calls are aborted (abort signal passed to provider SDK)
- [x] Remaining stages don't execute if run is cancelled
- [x] Clear status message displayed in terminal
- [x] Exit code 130 (SIGINT convention)
