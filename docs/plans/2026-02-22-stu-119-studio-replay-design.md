# STU-119: `studio replay <run-id>` — Design

## Problem

When a pipeline fails or produces unexpected results, debugging requires either re-running (expensive in tokens) or reading raw JSONL (unreadable). There's no way to re-visualize a past run with the same UX as `--live --verbose`.

## Solution

New command `studio replay <run-id>` that reads a JSONL log file and feeds the events into the existing `ProgressDisplay` renderer, producing output visually identical to `studio run --live`.

```bash
studio replay 648ae4e4
studio replay 648ae4e4 --verbose
```

## Architecture

```
JSONL file → readLines → parseJsonlEvent() → mapToEngineEvent() → ProgressDisplay handlers
```

### Files

- **New:** `cli/src/commands/replay.ts` — command handler + JSONL-to-event mapping
- **Modified:** `cli/src/index.ts` — register the `replay` command

### JSONL file discovery

Reuse the same pattern as `cli/src/commands/logs.ts`:
1. `findStudioDir(cwd)` to locate `.studio/`
2. Scan `.studio/runs/logs/*.jsonl` for files whose name contains the run-id prefix
3. Partial run-id matching (e.g., `648a` matches `648ae4e4` in the filename)
4. Error if no match or ambiguous multiple matches

### Event mapping

A `mapJsonlToEvent()` function translates JSONL field names to `EngineEvents` handler signatures:

| JSONL field | EngineEvents field |
|---|---|
| `stage` | `stage_name` |
| `group` | `group_name` |
| `tokens.{prompt,completion,total}` | `token_usage.{prompt_tokens,completion_tokens,total_tokens}` |

### Renderer

`ProgressDisplay` instantiated with `{ live: true, verbose: options.verbose }`. Events are fed synchronously (instant replay, no artificial delays). Spinners will flash through instantly — the textual output (stage names, tool calls, outputs, summaries) renders correctly.

### Summary

The `pipeline_complete` JSONL event carries `status`, `duration_ms`, `total_tokens`, `total_tool_calls` — `ProgressDisplay.onPipelineComplete` renders the same final summary as a live run.

### Error handling

- No matching JSONL → clear error suggesting `studio logs` to list available runs
- Multiple matches → error listing ambiguous matches
- Corrupt lines → skip with warning, continue replay

## Not in scope

- Streaming events (onAgentThinking/onAgentProgress/onAgentToken) — not logged to JSONL, not replayable
- Artificial delays between events
- SQLite interaction — purely JSONL-based
- `--json` flag — this is a visual debugging tool

## Acceptance criteria

- [x] `studio replay <run-id>` finds the correct JSONL file
- [x] Rendering is visually identical to `studio run --live`
- [x] `--verbose` shows complete outputs and tool call results
- [x] Final summary (status, duration, tokens, stages) is displayed
- [x] Partial run-id (8 chars or less) is accepted
- [x] Clear error if run-id not found
