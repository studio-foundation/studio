# STU-66: Improve CLI Output for Pipeline Execution (UX Polish)

## Context

The CLI already has a solid `ProgressDisplay` class with 3 modes (quiet/verbose/live), ora spinners, tool call summaries, and event-driven rendering. The event payloads carry tokens, duration, attempts, tool_calls, and rejection info.

The current output is functional but doesn't match the polished target UX from the issue. This design covers the "progress improvements" scope — the "Changes" file-diff footer is deferred to a separate issue.

## Target UX (quiet mode)

```
$ studio run feature-builder --input-file brief.yaml

✓ Input collected

[1/4] brief-analysis ............ ⏳ (attempt 1/3)
[1/4] brief-analysis ............ ✓ (12s, 2.1k tokens)

[2/4] implementation-plan ....... ⏳ (attempt 1/3)
[2/4] implementation-plan ....... ✓ (18s, 3.5k tokens)

[3/4] code-generation ........... ⏳ (attempt 1/5)
[3/4] code-generation ........... ✗ retry (no tool calls detected)
[3/4] code-generation ........... ⏳ (attempt 2/5)
[3/4] code-generation ........... ✓ (45s, 8.2k tokens, 3 files)

[4/4] qa-review ................. ⏳ (attempt 1/3)
[4/4] qa-review ................. ✓ (22s, 4.1k tokens)

✓ Pipeline completed (1m37s, 17.9k tokens total)

Run ID: run_abc123
View details: studio status run_abc123
```

## Approach

Modify `ProgressDisplay` in-place + add formatting helpers. No new files, no structural changes.

## Design

### 1. New formatting helpers (formatters.ts)

**`formatTokens(count: number): string`**
- `450` → `"450"`
- `2100` → `"2.1k"`
- `17900` → `"17.9k"`
- `1234567` → `"1.2M"`

**`formatStageLine(prefix: string, name: string, suffix: string): string`**
- Fills dots between name and suffix to a fixed column width (42 chars from `[` to status)
- `formatStageLine("[1/4]", "brief-analysis", "✓ (12s, 2.1k tokens)")`
- → `"[1/4] brief-analysis ............ ✓ (12s, 2.1k tokens)"`

### 2. Stage name format change

Use raw kebab-case stage name (`brief-analysis`) instead of human-readable (`Analyzing brief`). Matches YAML config, unambiguous, greppable. The `humanReadableStageName()` function is kept for live mode tool output but no longer used in stage lines.

### 3. Spinner with attempt counter (progress.ts)

**onStageStart:** Spinner text becomes `[1/4] brief-analysis ............ ⏳ (attempt 1/3)`

Requires `max_attempts` in `StageStartEvent`. Currently the event only has `{ stage_name, stage_index, total_stages }`.

**Engine change:** Add `max_attempts: number` to `StageStartEvent` type in contracts, emit it from the engine's `executeStage()` (the value comes from the stage's ralph settings).

### 4. Stage completion line (progress.ts)

**onStageComplete:** Replace spinner with:
```
[3/4] code-generation ........... ✓ (45s, 8.2k tokens, 3 files)
```

Parts:
- Duration: always shown
- Tokens: shown if > 0, compact format
- Files: shown if tool_calls include `write_file` calls (count extracted from tool_calls array)

### 5. Retry display (progress.ts)

**onTaskRetry:** Instead of a multi-line block:
```
  ↻ Retry #1:
    - No tool calls detected
```

Use inline format — fail the current spinner, start a new one:
```
[3/4] code-generation ........... ✗ retry (no tool calls detected)
[3/4] code-generation ........... ⏳ (attempt 2/5)
```

The first failure reason from `event.failures[0]` is shown inline. Verbose mode can still show additional details below.

### 6. Pipeline footer (progress.ts)

**onPipelineComplete:**
```
✓ Pipeline completed (1m37s, 17.9k tokens total)

Run ID: run_abc123
View details: studio status run_abc123
```

- Merge tokens into the completion line
- Show run ID (stored from `onPipelineStart`)
- Show `studio status` hint
- **Remove `formatResult()` duplicate summary** from `run.ts` — the progress display already showed each stage inline

### 7. Input confirmation (run.ts)

After input wizard or `--input`/`--input-file` resolves, print:
```
✓ Input collected
```

One line addition after the input resolution block.

### 8. Group display (unchanged)

Groups stay roughly the same — iteration messages appear between stage blocks:
```
[4/4] qa-review ................. ✗ rejected (implementation incomplete)
  ↻ Feedback loop iteration 2/3

[3/4] code-generation ........... ⏳ (attempt 1/5)
```

## Files modified

| File | Change |
|------|--------|
| `contracts/` | Add `max_attempts` to `StageStartEvent` type |
| `engine/src/events.ts` | Update `StageStartEvent` if defined here |
| `engine/src/engine.ts` | Pass `max_attempts` in `onStageStart` emission |
| `cli/src/output/formatters.ts` | Add `formatTokens()`, `formatStageLine()` |
| `cli/src/output/progress.ts` | Rewrite event handlers for new format |
| `cli/src/output/formatter.ts` | Remove/simplify `formatResult()` |
| `cli/src/commands/run.ts` | Add "Input collected", remove `formatResult()` call, track run_id |

## What stays the same

- **Live mode** — tool call streaming, thinking text, tool spinners
- **Verbose mode** — JSON output dump, token breakdown (on top of new format)
- **JSON mode** — unchanged
- **JSONL logging** — `mergeEvents` logger unchanged
- **Group events** — iteration/feedback messages

## Deferred

- "Changes" file-diff footer (separate Linear issue)
