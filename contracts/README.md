# @studio/contracts

Shared TypeScript types and interfaces for the Studio monorepo. Zero dependencies, zero logic.

## Role

`contracts` is the leaf package — every other Studio package imports from it, nothing imports it back. It defines the language that all packages speak.

```
contracts ← ralph
contracts ← runner
contracts ← engine
contracts ← cli
```

## What's in here

| Module | Purpose |
|--------|---------|
| `pipeline.ts` | `PipelineDefinition`, `StageDefinition`, `GroupDefinition` |
| `stage.ts` | `StageStatus`, `StageResult`, `StageOutput` |
| `task.ts` | `TaskDefinition`, `RalphSettings` |
| `agent.ts` | `AgentProfile`, `AgentConfig` |
| `run.ts` | `RunRecord`, `RunStatus`, `RunSummary` |
| `validation.ts` | `OutputContract`, `ValidationResult`, `ToolCallConstraints` |
| `provider.ts` | `LLMResponse`, `ToolCall`, `TokenUsage` |
| `errors.ts` | `StudioError` and subtypes |
| `context-pack.ts` | `ContextPack`, `ContextPackDefinition` |

## Rules

- **Zero dependencies** — no imports from other `@studio/*` packages, ever.
- **Zero logic** — types and interfaces only. No functions, no classes.
- If you need to add a type used by two packages, put it here.
- If you're adding logic, you're in the wrong package.
