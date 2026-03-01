# @studio/ralph

The retry engine. Execute → validate → retry with escalated feedback → repeat.

**RALPH** = Recursive Automated Loop for Persistent Handling.

## Role

ralph sits between the engine (orchestration) and runner (LLM execution). It knows nothing about LLMs — it takes a generic `executor` function and a contract, and loops until the output passes or max attempts is reached.

```
engine → ralph(executor, contract) → success | exhausted
                 ↑
         executor = () => runner.runAgent(...)
```

## Key exports

```typescript
import { ralph, RalphConfig, RalphResult } from '@studio/ralph';
import { validateSchema, validateToolCalls, validateRequiredTools, compose } from '@studio/ralph';
import { exponentialBackoff, fixedDelay, noDelay } from '@studio/ralph';

const result = await ralph({
  executor: async (context) => runner.runAgent(context),
  validator: compose(
    (r) => validateSchema(r.output, contract),
    (r) => validateToolCalls(r.tool_calls_count, requirements),
  ),
  maxAttempts: 3,
  retryStrategy: exponentialBackoff(1000, 30000),
  onRetry: async (event) => { /* observability hook */ },
  signal: abortController.signal,  // optional — enables cooperative cancellation
});
// result.status: 'success' | 'exhausted' | 'cancelled'
```

## How it works

1. Calls `executor` with current context
2. Validates the output using the `validator` function (composed validators)
3. If pass → returns `{ status: 'success', result, attempts }`
4. If fail → calls `onRetry`, waits (retry strategy), retries with failure context
5. If max attempts reached → returns `{ status: 'exhausted', lastResult, failures, attempts }`
6. If `signal` is aborted at any point → returns `{ status: 'cancelled', lastResult?, attempts }`

## Validators

ralph exports composable validators that the engine uses to build per-stage validation:

| Validator | Purpose |
|-----------|---------|
| `validateSchema(output, contract)` | Check required fields are present |
| `validateToolCalls(count, reqs)` | Check minimum tool call count |
| `validateRequiredTools(calls, reqs)` | Check specific tools were called |
| `validateCountedTools(calls, reqs)` | OR semantics — any of these count toward minimum |
| `compose(...validators)` | Combine multiple validators (all must pass) |

## Retry strategies

| Strategy | Behavior |
|----------|----------|
| `exponentialBackoff(min, max)` | Exponential backoff with jitter |
| `fixedDelay(ms)` | Fixed wait between attempts |
| `noDelay()` | No wait (prompt escalation handled by runner) |

## Rules

- **ralph doesn't know runner.** The `executor` is `() => Promise<T>`. ralph doesn't care what's behind it.
- **ralph doesn't know engine.** It takes config, it returns a result. No pipeline state, no events.
- Validation logic is in exported validators — the engine composes them per stage.
