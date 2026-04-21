# @studio-foundation/engine

**Studio** is an agentic pipeline runtime that executes multi-stage LLM workflows with structural validation and automatic retry. This package is the **engine**: pipeline orchestration, state machine, persistence, lifecycle hooks, and skills injection.

It loads pipeline configs, sequences stages, delegates each stage to [`ralph`](https://www.npmjs.com/package/@studio-foundation/ralph) + [`runner`](https://www.npmjs.com/package/@studio-foundation/runner), persists state, and emits events for observability. It knows about pipelines, stages, groups, hooks, and skills — but never about LLMs, files, or domain concepts.

- Homepage: https://github.com/studio-foundation/studio
- Full docs: [README](https://github.com/studio-foundation/studio#readme) · [CONCEPTS](https://github.com/studio-foundation/studio/blob/main/CONCEPTS.md) · [INVARIANTS](https://github.com/studio-foundation/studio/blob/main/INVARIANTS.md)
- Use via the CLI: [`@studio-foundation/cli`](https://www.npmjs.com/package/@studio-foundation/cli)

## Install

```bash
npm install @studio-foundation/engine
# or
pnpm add @studio-foundation/engine
```

Most users don't consume `engine` directly — they use the [`studio`](https://www.npmjs.com/package/@studio-foundation/cli) CLI, which wraps it. Install this package if you're embedding Studio into your own runtime.

## Quick start

```typescript
import { PipelineEngine } from '@studio-foundation/engine';

const engine = new PipelineEngine({
  configsDir: '.studio',          // Root of .studio/ directory
  repoPath: '/path/to/workspace', // Where tools operate (optional)
  providerRegistry,
  toolRegistry,
  db: runStore,
  pluginSkills: {                 // Skills from Claude Code plugins, keyed by plugin name
    'my-plugin': ['## Skill: commit-conventions\n...'],
  },
});

const run = await engine.run({
  pipeline: 'feature-builder',
  input: { brief: 'Add dark mode' },
  anonymize: true,  // Enable PII anonymization for this run
});
```

## Architecture

```
cli → engine.run(pipeline, input) → PipelineRun
          ↓
      [load pipeline] → [on_pipeline_start] → [for each stage: hooks + ralph(runner)] → [persist state] → [emit events]
```

## State machine

```
pending → running → success
                  → failed     (ralph exhausted all attempts, or on_stage_start hook with on_failure: fail)
                  → rejected   (post_validation rejection, or hook with on_failure: reject)
                  → skipped
```

`deriveStageStatus()` in `state/status-derivation.ts` is the critical mapping function: ralph result → stage status. One place, deterministic.

## Lifecycle hooks

The engine executes stage hooks at four deterministic points:

| Hook | When | Template vars |
|------|------|---------------|
| `on_stage_start` | Before ralph loop | None |
| `on_stage_complete` | After stage succeeds | `{{output.field}}` |
| `pre_tool_use` | Before a tool call (matcher-gated) | `{{tool.argName}}` |
| `post_tool_use` | After a tool call (matcher-gated) | `{{tool.argName}}` |

Hook failure semantics via `on_failure`:
- `warn` (default) — log and continue
- `reject` — stage → `rejected` (can trigger group retry)
- `fail` — stage → `failed` (stops pipeline)

`pre_tool_use` hooks with any failure block the tool call. Hook commands run in `repoPath` (or `configsDir` as fallback). Implemented in `pipeline/hook-executor.ts`.

## on_pipeline_start

Commands in `pipeline.on_pipeline_start` execute before any stage and inject their stdout into the pipeline context:

```yaml
on_pipeline_start:
  - command: "git status --short"
    inject_as: git_status
```

Implemented in `pipeline/startup-executor.ts`. Failures are non-fatal (logged, pipeline continues).

## Skills injection

Agents that declare `skills: [name]` in their YAML get `.studio/skills/<name>.skill.md` auto-injected into their system prompt. Loaded by `pipeline/skill-loader.ts`. Missing skill files are non-fatal (warned, skipped).

Plugin skills (`pluginSkills` in `EngineConfig`) are injected for agents that declare `plugins: [plugin-name]`.

## Events

The engine emits structured events at every lifecycle point. See `events.ts`:

| Event | When |
|-------|------|
| `onPipelineStart` / `onPipelineComplete` | Pipeline lifecycle |
| `onStageStart` / `onStageComplete` | Stage lifecycle |
| `onTaskRetry` | RALPH retry |
| `onGroupStart` / `onGroupIteration` / `onGroupFeedback` / `onGroupComplete` | Group lifecycle |
| `onToolCallStart` / `onToolCallComplete` | Tool call lifecycle |
| `onAgentThinking` / `onAgentProgress` / `onAgentToken` | Streaming events |

The CLI subscribes to these events to render progress output and stream tokens.

## Groups

A group is a set of stages that iterate together. If the last stage rejects (via `post_validation.rejection_detection` in its contract), the group reruns from the first stage with accumulated feedback. `max_iterations` caps the loop.

## PII Anonymization

```typescript
engine.run({ pipeline, input, anonymize: true })
// Keymap persisted to .studio/runs/anonymization/<run-id>.keymap.json
```

Per-agent anonymization also supported via `anonymize: true` in agent YAML.

## For contributors

Internal rules that govern this package:

- **engine is domain-agnostic.** No references to "code", "file", "git", "QA" in engine source. All domain knowledge is in YAML configs.
- **engine doesn't execute tools.** It passes tool configs to runner. The runner decides what `repo_manager-write_file` means.
- **engine doesn't build prompts.** That's runner's job.
- Persistence: `PgRunStore` (PostgreSQL) for production, `InMemoryRunStore` for tests. Both implement `AnyRunStore`.

## License

AGPL-3.0-only
