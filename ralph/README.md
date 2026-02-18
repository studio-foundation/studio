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

const result = await ralph({
  executor: async (context) => runner.runAgent(context),
  contract: outputContract,
  config: { max_attempts: 3, retry_strategy: 'exponential' },
  context: stageContext,
});
// result.status: 'success' | 'exhausted'
```

## How it works

1. Calls `executor` with current context
2. Validates the output against the contract (`validator.ts`)
3. If pass → returns `{ status: 'success', output }`
4. If fail → enriches context with failure feedback (`context-enricher.ts`), waits (retry strategy), retries
5. If max attempts reached → returns `{ status: 'exhausted', attempts }`

## Rules

- **ralph doesn't know runner.** The `executor` is `() => Promise<T>`. ralph doesn't care what's behind it.
- **ralph doesn't know engine.** It takes config, it returns a result. No pipeline state, no events.
- Validation logic lives in `validator.ts`. Context enrichment (building retry feedback) in `context-enricher.ts`.
