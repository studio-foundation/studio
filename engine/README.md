# @studio/engine

Pipeline orchestration, state machine, and persistence.

## Role

engine is the conductor. It loads pipeline configs, sequences stages, delegates execution to ralph+runner, tracks state in SQLite, and emits events for observability. It knows about pipelines, stages, and groups — but never about LLMs, files, or domain concepts.

```
cli → engine.run(pipeline, input) → RunRecord
          ↓
      [load pipeline] → [for each stage: ralph(runner)] → [persist state] → [emit events]
```

## Key exports

```typescript
import { PipelineEngine } from '@studio/engine';

const engine = new PipelineEngine({
  configsDir: '.studio/projects',
  providerRegistry,
  toolRegistry,
  runStore,
  events,
});

const run = await engine.run({
  project: 'software',
  pipeline: 'feature-builder',
  input: { brief: 'Add dark mode' },
});
```

## State machine

```
pending → running → success
                  → failed     (ralph exhausted all attempts)
                  → rejected   (post_validation rejection detected)
                  → skipped
```

`deriveStageStatus()` in `state/status-derivation.ts` is the critical mapping function: ralph result → stage status. One place, deterministic.

## Events

The engine emits structured events at every lifecycle point. See `events.ts` for the full list: `onPipelineStart`, `onStageComplete`, `onGroupIteration`, `onTaskRetry`, etc.

The CLI subscribes to these events to render progress output.

## Groups

A group is a set of stages that iterate together. If the last stage rejects (via `post_validation.rejection_detection` in its contract), the group reruns from the first stage with accumulated feedback. `max_iterations` caps the loop.

## Rules

- **engine is domain-agnostic.** No references to "code", "file", "git", "QA" in engine source. All domain knowledge is in YAML configs.
- **engine doesn't execute tools.** It passes tool configs to runner. The runner decides what `repo_manager-write_file` means.
- **engine doesn't build prompts.** That's runner's job.
- Persistence: `SQLiteRunStore` for production, `InMemoryRunStore` for tests.
