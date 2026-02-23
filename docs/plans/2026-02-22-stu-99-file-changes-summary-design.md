# STU-99: File Changes Summary at End of Pipeline Run

## Problem

After a pipeline run, the user has no visibility into which files were created or modified. They must manually check `git status` or `git diff` to see what happened.

## Solution

Display a git-diff-style summary at the end of every `studio run` output showing files written during the pipeline.

## Target UX

```
Changes:
  M src/components/TodoList.tsx   (+15 -3)
  A src/components/Filter.tsx     (new file, 42 lines)
```

- **M** = modified (file existed before, was overwritten)
- **A** = added (new file, previously untracked)
- Line counts from `git diff --numstat` for M, `wc -l` for A

## Architecture

**CLI-only feature.** The engine stays domain-agnostic — no file/git concepts in engine code.

### Data flow

1. **During the run:** CLI listens to `onToolCallComplete` events. When `tool === "repo_manager-write_file"`, record `arguments.path` into a `Set<string>`.

2. **After pipeline completes:** For every tracked path, run `git diff --numstat -- <files>` to get line-level changes. Files in the set but absent from git diff output are new (untracked) — count lines with `wc -l`.

3. **Display:** Append a "Changes" block after the stages summary in `formatResult()`.

### Why tool-call-filtered git diff

- Pure `git diff --stat` would include pre-existing uncommitted changes the pipeline didn't make.
- Pure tool-call tracking can't compute real line diffs (no before-content).
- Hybrid: tool calls give us the **file list**, git gives us the **line counts**. Most precise.

## Components

| Component | File | Responsibility |
|-----------|------|----------------|
| `FileChangeCollector` | `cli/src/output/file-changes.ts` (new) | Collect paths from tool calls, compute diff via git, format output |
| Integration | `cli/src/commands/run.ts` | Wire collector into `onToolCallComplete`, call summary after pipeline |
| Display | `cli/src/output/formatter.ts` | Append changes block to result output |

## Behavior

- Shown for **all** pipeline outcomes (success, failed, rejected)
- Hidden when no `repo_manager-write_file` calls were made
- **No git repo:** Skip silently (graceful degradation)
- **Git command fails:** Skip silently
- **Same file written multiple times:** Deduplicated via `Set`, git diff shows net result
- **`--json` mode:** Not included (raw JSON unchanged)

## Non-goals

- Tracking file deletions (no delete tool exists yet)
- Tracking file reads
- Showing diffs in engine events or JSONL logs
