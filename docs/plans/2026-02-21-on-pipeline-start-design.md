# Design: `on_pipeline_start` — Dynamic Context Injection at Pipeline Start

**Issue:** STU-95
**Date:** 2026-02-21
**Status:** Approved

## Problem

Agent context in Studio is static — whatever is in `context.include` of the pipeline YAML. There is no mechanism to inject fresh, dynamic context at run time (e.g. current git status, recent commits, build state). Agents start blind to the live state of the workspace.

## Solution

Add an `on_pipeline_start` section to the pipeline YAML. The engine executes the listed shell commands once, before any stage runs, and stores their output. Stages opt in via `context.include: [pipeline_start_context]`.

## YAML Format

```yaml
name: feature-builder
on_pipeline_start:
  - command: "git status --short"
    inject_as: git_status
  - command: "git log --oneline -5"
    inject_as: recent_commits
  - command: "cat package.json | jq '.scripts'"
    inject_as: available_scripts

stages:
  - name: brief-analysis
    kind: analysis
    agent: analyst
    context:
      include: [input, pipeline_start_context]
```

Each `command` is a shell command run in `repoPath` (or `configsDir` if no repo). Each `inject_as` becomes a named key in the startup context.

## Architecture

### Data Flow

```
pipeline YAML parsed → on_pipeline_start commands extracted
                     ↓
engine.run() → executeStartupCommands(commands, cwd)
             ↓
           PipelineContext.startupContext = { git_status: "...", recent_commits: "..." }
             ↓
getContextForStage() sees pipeline_start_context in context.include
             ↓
AgentContext.startup_context = { git_status: "...", ... }
             ↓
prompt-builder renders each key as a separate ### section under ## Pipeline Startup Context
```

### Files Changed

| File | Change |
|------|--------|
| `contracts/src/pipeline.ts` | Add `StartupCommand` type; add `on_pipeline_start?: StartupCommand[]` to `PipelineDefinition` |
| `engine/src/pipeline/loader.ts` | Parse `on_pipeline_start` from YAML, validate each entry has `command` and `inject_as` |
| `engine/src/pipeline/startup-executor.ts` | **New file** — execute commands, collect results |
| `engine/src/pipeline/context-propagation.ts` | Add `startupContext?: Record<string, string>` to `PipelineContext`; add `pipeline_start_context` case to `getContextForStage()` |
| `engine/src/engine.ts` | Call `executeStartupCommands()` after `createInitialContext()`, store result in context |
| `runner/src/prompt-builder.ts` | Add `startup_context?: Record<string, string>` to `AgentContext`; render as `### key` sections |

## Component Details

### `StartupCommand` (contracts)

```typescript
export interface StartupCommand {
  command: string;
  inject_as: string;
}
// Added to PipelineDefinition:
on_pipeline_start?: StartupCommand[];
```

### `startup-executor.ts` (engine — new)

```typescript
async function executeStartupCommands(
  commands: StartupCommand[],
  cwd?: string
): Promise<Record<string, string>>
```

- Uses `node:child_process` `exec` with a 10-second timeout per command
- Returns a map of `inject_as → stdout`
- Failed commands: warn to console, skip the key — pipeline continues

### `AgentContext` addition (runner)

```typescript
startup_context?: Record<string, string>;
```

### Prompt rendering

```
## Pipeline Startup Context

### git_status
```
M src/engine.ts
?? src/new-file.ts
```

### recent_commits
```
abc123 feat(engine): add skill loader
```
```

## Error Handling

- Command exits non-zero or throws → `console.warn`, key skipped, pipeline continues
- Command times out (10s) → same warn + skip
- `on_pipeline_start` absent → phase skipped entirely, zero cost
- Stage includes `pipeline_start_context` but no commands ran → no section rendered in prompt

## Testing Plan

| Test file | Coverage |
|-----------|----------|
| `startup-executor.test.ts` | Success, non-zero exit (skip + warn), timeout |
| `loader.test.ts` | Parse `on_pipeline_start`; validate missing `command`/`inject_as` |
| `context-propagation.test.ts` | `pipeline_start_context` case in `getContextForStage()` |
| `prompt-builder.test.ts` | Renders each key as `### section`; skips when `startup_context` empty |
| `engine.test.ts` | Integration: startup commands available in stage context |

## Approach Selected

**Approach A — Engine executes commands directly via `child_process`.**

Rejected alternatives:
- **Approach B** (runner function): runner is designed around LLM agent execution, not programmatic bootstrapping
- **Approach C** (CLI pre-processing): leaks pipeline internals to callers; every caller must re-implement
