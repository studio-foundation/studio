# Design: `studio replay --restart` — Re-execute Pipeline from a Specific Stage

**Linear:** STU-242
**Date:** 2026-03-21
**Status:** Approved

---

## Problem

`studio replay <run-id>` only replays the visual log of a past run. There is no way to re-execute a pipeline starting from a specific stage, which is needed when a stage fails mid-pipeline and you want to restart without re-running the stages that already succeeded.

---

## Solution Overview

Add `--restart` and `--stage` flags to `studio replay`. When `--restart` is used, the command switches from visualization mode to re-execution mode: it reconstructs prior stage outputs from the JSONL log, injects them into the engine as pre-computed context, skips stages before the target, and executes from the target stage onward as a new run.

```bash
studio replay --restart 2786b753 --stage 9
studio replay --restart 2786b753 --stage code-generation
```

---

## Architecture Decision

**Engine-native resume (Option A chosen):** The engine receives pre-extracted prior outputs via new `RunOptions` fields and handles both context pre-population and stage skipping. The CLI stays thin — it parses JSONL and passes data to the engine. The engine remains the single owner of `PipelineContext`.

Rejected alternatives:
- **CLI-side injection:** CLI would have to understand `PipelineContext` internals, breaking separation of concerns.
- **New `studio resume` command:** Contradicts the ticket spec.

---

## Section 1 — CLI Layer

**File:** `cli/src/commands/replay.ts`

### New Flags

| Flag | Type | Description |
|------|------|-------------|
| `--restart` | boolean | Switches from visualization to re-execution mode |
| `--stage <index\|name>` | string | Required with `--restart`; 0-based index or stage name |

### Restart Flow

1. Find the JSONL log for the given run ID via existing `findJsonlFile()`
2. Parse JSONL to extract:
   - Pipeline input (from `pipeline_start` event)
   - All `stage_complete` outputs + tool calls for stages before the target
   - Stage name order (from `stage_start` events)
3. Load the current pipeline YAML to resolve `--stage` to a stage name
   - If integer: map index → stage name from current YAML
   - If string: validate the name exists in current YAML
4. Call `engine.run()` with new `RunOptions` fields
5. Stream the new run exactly like `studio run` (live output, new run ID printed)

### Skipped Stages

Stages 0 to N-1 are written into the new run as synthetic `StageRun` entries:
- `status: 'skipped'`
- `skipped_reason: "resumed from run <original-id>"`

These appear in `studio status` output.

---

## Section 2 — Engine Layer

**Files:** `engine/src/engine.ts`, `@studio/contracts` (RunOptions)

### New `RunInput` Fields

The interface is `RunInput`, defined in `engine/src/engine.ts` (not in `@studio/contracts`). `ToolCall` is imported from `@studio/contracts` (exported via `contracts/src/agent.ts`).

```typescript
interface RunInput {
  // ... existing fields ...
  resumeFromStage?: string;                         // stage name to start from
  priorStageOutputs?: Map<string, unknown>;         // keyed by stage name
  priorStageToolResults?: Map<string, ToolCall[]>;  // keyed by stage name
  originalRunId?: string;                           // for skipped_reason message
}
```

### Engine Loop Changes

**Before the loop:** if `resumeFromStage` is set:
- Pre-populate `PipelineContext` via existing `addStageOutput()` and `addStageToolResults()` for all prior stages
- `on_pipeline_start` commands still re-execute (fresh repo state)

**In the loop:** stages before `resumeFromStage`:
- Get a synthetic `StageRun` with `status: 'skipped'`
- Added to `run.stages[]` but no executor called
- Engine continues immediately to the target stage

**From target stage onward:** normal execution — no changes to `stage-executor.ts`, `context-propagation.ts`, or `ralph`. Pre-populated context flows through unchanged via existing `getContextForStage()`.

---

## Section 3 — Error Handling & Edge Cases

| Case | Behavior |
|------|----------|
| Stage name not found in current YAML | CLI exits with clear error before calling engine |
| Stage index out of bounds | CLI exits with clear error |
| `--stage 0` | Valid, no stages skipped; warning printed ("equivalent to a fresh run") |
| Missing output in JSONL (prior stage failed) | Output absent from `priorStageOutputs`; warning printed; execution continues with available context |
| Pipeline YAML changed (stage names differ) | `--stage` resolution fails with clear error |
| `--stage` targets a stage inside a group | Group starts fresh from that stage at iteration 1; prior group feedback not replayed |
| Integer index with groups | Index counts **leaf stages only** (not group containers). A pipeline with stages `[brief-analysis, group(code-gen, qa-review)]` has indices 0=brief-analysis, 1=code-gen, 2=qa-review. Group containers are transparent to indexing. |
| `on_pipeline_start` context inconsistency | `on_pipeline_start` re-runs and produces fresh startup context (e.g., new `git status`). Prior stage outputs were generated with the old startup context. This inconsistency is **intentional** — the user is restarting because the repo state changed. The tradeoff is documented, not prevented. |
| JSONL `tool_calls` field shape | `stage_complete` events currently log `tool_calls` as `ToolCallSummary[]` (name + arguments_summary string), not full `ToolCall[]`. As a prerequisite, `StageCompleteEvent.tool_calls` in `engine/src/events.ts` must be changed from `ToolCallSummary[]` to `ToolCall[]`, and the JSONL writer in `cli/src/commands/run.ts` updated accordingly. This enables faithful reconstruction of `priorStageToolResults` from the log. |

---

## Files Touched

| File | Change |
|------|--------|
| `cli/src/commands/replay.ts` | Add `--restart`, `--stage` flags; JSONL parsing; engine call |
| `cli/src/index.ts` | Register new `--restart` and `--stage` options on the `replay` command |
| `contracts/src/run.ts` | Add `skipped_reason?: string` to `StageRun` (note: `'skipped'` is already a valid `StageStatus`) |
| `engine/src/events.ts` | Change `StageCompleteEvent.tool_calls` from `ToolCallSummary[]` to `ToolCall[]` (prerequisite for faithful JSONL reconstruction) |
| `cli/src/commands/run.ts` | Update JSONL writer to log full `ToolCall[]` instead of `ToolCallSummary[]` on `stage_complete` |
| `engine/src/engine.ts` | Add `resumeFromStage`, `priorStageOutputs`, `priorStageToolResults`, `originalRunId` to `RunInput`; pre-populate context; synthetic skipped stages in loop |

**No changes to:** `stage-executor.ts`, `context-propagation.ts`, `ralph/`, `runner/`

## Tests

| File | Coverage |
|------|----------|
| `cli/src/commands/replay.test.ts` | JSONL parsing logic: extract input, stage outputs, tool calls from past run events |
| `engine/src/engine.test.ts` | Resume loop: stages before target are skipped; context pre-populated correctly; stages after target execute |

---

## Behavior Summary

```bash
# Original run (failed at stage 9)
studio run feature-builder --input "Add dark mode"
# Run ID: 2786b753, stages 0-8 succeeded, stage 9 failed

# Restart from stage 9
studio replay --restart 2786b753 --stage 9
# New run ID: a4f1c209
# Stages 0-8: skipped (cached from 2786b753)
# on_pipeline_start: re-executed (fresh git status)
# Stages 9+: executed live with the current pipeline YAML
```
