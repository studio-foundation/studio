# Design: stage_context Event (STU-127)

## Problem

Context propagation between stages is invisible. When debugging "the coder didn't have group_feedback on iteration 3", you have to guess. The JSONL logs show inputs/outputs but not what the agent actually received as context.

## Solution

Add a `stage_context` event emitted at each stage start, after context assembly, before the ralph loop. Three verbosity levels controlled by `DEBUG=studio:context` and `DEBUG=studio:context:verbose`.

## Architecture

**4 files changed, no new packages, no new dependencies.**

| File | Change |
|------|--------|
| `engine/src/events.ts` | Add `StageContextEvent` interface + `onStageContext?` to `EngineEvents` |
| `engine/src/pipeline/context-propagation.ts` | Add `stageOutputSizes` to `PipelineContext`; populate in `addStageOutput()`; export `buildContextKeys()` and `buildContextContent()` |
| `engine/src/engine.ts` | Emit `onStageContext` in `executeStage()` between context pack loading and ralph loop |
| `cli/src/commands/run.ts` | Add `onStageContext` handler in `mergeEvents()` for JSONL logging |

## Event Structure

```typescript
export interface StageContextEvent {
  stage: string;
  run_id: string;
  context_keys: Record<string, number>;      // always present: key → char count
  context_content?: Record<string, unknown>; // DEBUG=studio:context
  system_prompt?: string;                    // DEBUG=studio:context:verbose
}
```

## Data Flow

Emission point in `executeStage()`:

```
onStageStart emitted          (current, unchanged)
agentConfig loaded
skills injected into agentConfig.system_prompt
contract loaded
agentContext = getContextForStage()
agentContext.context_packs = await loadContextPacks()
← onStageContext emitted HERE
ralph loop starts
```

## context_keys Mapping

| Key | Source | Size |
|-----|--------|------|
| `input` | `agentContext.additional_context` | `.length` (already a string, O(1)) |
| `previous_stage_output` | all values in `agentContext.previous_outputs` | sum of pre-tracked sizes in `PipelineContext.stageOutputSizes` |
| `group_feedback` | `agentContext.group_feedback` | `JSON.stringify().length` (small object) |
| `<key>` (startup) | each key in `agentContext.startup_context` individually | `.length` (already strings, O(1)) |
| `<pack-name>` (context packs) | each pack's sections | sum of `section.content.length` |

Absent keys are not included.

## Performance

**Early exit when no handler:**
```typescript
if (!this.events?.onStageContext) return;
// zero work done
```

**Pre-tracked sizes for previous_outputs:**

`PipelineContext` gains `stageOutputSizes: Map<string, number>`. Populated in `addStageOutput()` at store time (one `JSON.stringify` per output addition, already happening in context memory). At emit time, size lookup is O(1) map access — no re-serialization.

**Full overhead matrix:**

| Scenario | Work done |
|----------|-----------|
| No `onStageContext` handler | None |
| Default (handler, no DEBUG) | O(1) map lookups + string `.length` |
| `DEBUG=studio:context` | Above + pass in-memory objects by reference |
| `DEBUG=studio:context:verbose` | Above + copy `agentConfig.system_prompt` string |

## DEBUG Flag Logic

```typescript
const debug = process.env.DEBUG ?? '';
const includeContent = debug.includes('studio:context');        // true for both levels
const includePrompt  = debug.includes('studio:context:verbose'); // verbose only
```

`verbose` implies `context` because `'studio:context:verbose'.includes('studio:context')` is true.

## system_prompt Scope (verbose)

`agentConfig.system_prompt` after skills injection (agent YAML system_prompt + `.skill.md` files). Tool plugin prompt snippets are excluded — they are added by the runner and are identical across runs for a given agent+tools configuration.

## JSONL Examples

**Default:**
```json
{"ts":"...","event":"stage_context","stage":"code-generation","run_id":"8bbd0ec8","context_keys":{"input":312,"previous_stage_output":847,"group_feedback":342,"git_status":156}}
```

**`DEBUG=studio:context`:**
```json
{"ts":"...","event":"stage_context","stage":"code-generation","run_id":"8bbd0ec8","context_keys":{"input":312,"previous_stage_output":847,"group_feedback":342,"git_status":156},"context_content":{"input":"Add dark mode...","previous_stage_output":{"brief-analysis":{...}},"group_feedback":{...},"git_status":"M src/..."}}
```

**`DEBUG=studio:context:verbose`:** same + `"system_prompt":"You are a senior engineer...\n\n## Skill: commit-conventions\n..."`

## Tests

**`context-propagation.test.ts`** — unit tests for `buildContextKeys()`:
- input only → `{ input: N }`
- previous_outputs aggregated → `{ previous_stage_output: N }`
- group_feedback → `{ group_feedback: N }`
- startup_context expanded individually → `{ git_status: N, recent_commits: M }`
- context_packs by name → `{ "my-pack": N }`
- empty agentContext → `{}`

**`engine.context-event.test.ts`** — integration tests:
- `onStageContext` is called once per stage
- `context_keys` has correct keys and numeric values
- `context_content` absent when no DEBUG flag
- `context_content` present when `DEBUG=studio:context`
- `system_prompt` absent when `DEBUG=studio:context`
- `system_prompt` present when `DEBUG=studio:context:verbose`
- zero calls to `onStageContext` when handler is not registered (early exit)

## Acceptance Criteria (from STU-127)

- [x] Event `stage_context` present in JSONL at each stage_start
- [x] Default: keys + char sizes, no content
- [x] `DEBUG=studio:context`: full content of context keys
- [x] `DEBUG=studio:context:verbose`: same + system_prompt
- [x] Levels are hierarchical: verbose implies context
- [x] Zero perf impact on runs without DEBUG
