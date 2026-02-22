# STU-94: Lifecycle Hooks — Design

**Date:** 2026-02-21
**Status:** Approved

## Problem

STU-91 proposed hardcoding a `shell-run_command` in the qa-review stage. The right solution is a generic, configurable hook system — not domain-specific code in the engine.

## Goal

YAML-configurable hooks that execute deterministic shell commands at lifecycle points within a pipeline stage: before/after the stage, and before/after each tool call.

## YAML Format

Hooks live inside the stage definition in `pipeline.yaml`:

```yaml
stages:
  - name: code-generation
    kind: code
    agent: coder
    contract: code-generation
    hooks:
      on_stage_start:
        - command: "git stash"
          on_failure: warn        # warn | reject | fail
      on_stage_complete:
        - command: "npx tsc --noEmit"
          on_failure: reject      # stderr → group_feedback
      pre_tool_use:
        - matcher: "repo_manager-write_file"
          command: "echo 'pre-write {{tool.path}}'"
          on_failure: warn
      post_tool_use:
        - matcher: "repo_manager-write_file"
          command: "npx prettier --write {{tool.path}}"
          on_failure: warn
```

- Template substitution: `{{tool.<arg_name>}}` maps to the tool call's arguments.
- `on_failure` defaults to `warn` for all hook types.
- Hook location: stage-level only (in pipeline.yaml). Agent-level hooks are out of scope.

## Architecture

### Layer Responsibilities

```
contracts   → StageHooks, StageHookDef, ToolHookDef, HookOnFailure types
              RunnerCallbacks += onPreToolUse  (async → { blocked, error? })
                              += onPostToolUse (async → { append_message? })

engine      → hook-executor.ts — shell execution + template rendering
              loader.ts — parse hooks from YAML
              engine.ts — on_stage_start/on_stage_complete called directly
                        — provides onPreToolUse/onPostToolUse as runAgent callbacks

runner      → runner.ts — honors onPreToolUse to block tool calls
                        — calls onPostToolUse, appends message to conversation
```

No boundary violations. `engine → runner` dependency already exists.

## Data Flow

### on_stage_start

1. Engine calls `runHooks(hooks.on_stage_start, cwd)` **before** the ralph loop.
2. Hook fails + `on_failure: fail/reject` → stage returns `failed`/`rejected` immediately, ralph never runs.
3. `on_failure: warn` → log, continue.

### pre_tool_use

1. Runner calls `onPreToolUse({ tool, params, timestamp })` before `toolExecutor.execute()`.
2. Engine callback runs all hooks whose `matcher` matches the tool name.
3. Any hook fails → callback returns `{ blocked: true, error: "hook stderr" }`.
4. Runner creates a synthetic failed ToolCall (error = hook message), adds it to `allToolCalls`, appends to conversation. LLM sees the error and can adjust. RALPH loop continues.
5. All hooks pass → `{ blocked: false }`, tool runs normally.

### post_tool_use

1. Runner calls `onPostToolUse({ tool, params, result, error, timestamp })` after execution.
2. Engine callback runs matching hooks.
3. Hook fails + `on_failure: reject` → callback returns `{ append_message: "Post-hook failed: <stderr>" }`.
4. Runner appends this message to the tool result in the conversation. LLM sees the error.
5. `on_failure: warn` → log only, callback returns `{}`.

### on_stage_complete

1. Engine calls `runHooks(hooks.on_stage_complete, cwd)` **after** the ralph loop completes.
2. Hook fails + `on_failure: reject` → `stageStatus` overridden to `rejected`, hook stderr injected via `setGroupFeedback()` (same mechanism as post-validation rejection).
3. `on_failure: fail` → `stageStatus` → `failed`.
4. `on_failure: warn` → log, status unchanged.

## New Types (contracts)

```typescript
// contracts/src/pipeline.ts

export type HookOnFailure = 'warn' | 'reject' | 'fail';

export interface StageHookDef {
  command: string;
  on_failure?: HookOnFailure;  // default: 'warn'
}

export interface ToolHookDef {
  matcher: string;
  command: string;
  on_failure?: HookOnFailure;  // default: 'warn'
}

export interface StageHooks {
  on_stage_start?: StageHookDef[];
  on_stage_complete?: StageHookDef[];
  pre_tool_use?: ToolHookDef[];
  post_tool_use?: ToolHookDef[];
}

// Extended StageDefinition:
export interface StageDefinition {
  // ... existing fields ...
  hooks?: StageHooks;
}
```

```typescript
// contracts/src/runner-events.ts

export interface RunnerCallbacks {
  // ... existing callbacks ...
  onPreToolUse?: (event: {
    tool: string;
    params: Record<string, unknown>;
    timestamp: number;
  }) => Promise<{ blocked: boolean; error?: string }>;

  onPostToolUse?: (event: {
    tool: string;
    params: Record<string, unknown>;
    result: unknown;
    error?: string;
    timestamp: number;
  }) => Promise<{ append_message?: string }>;
}
```

## New File: engine/src/pipeline/hook-executor.ts

```typescript
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { StageHookDef, ToolHookDef } from '@studio/contracts';

const execAsync = promisify(exec);
const HOOK_TIMEOUT_MS = 30_000;

export interface HookResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

// Renders {{tool.argName}} placeholders from tool arguments
function renderHookCommand(command: string, toolArgs: Record<string, unknown>): string {
  return command.replace(/\{\{tool\.(\w+)\}\}/g, (_, key: string) =>
    toolArgs[key] !== undefined ? String(toolArgs[key]) : ''
  );
}

export async function runStageHook(hook: StageHookDef, cwd: string): Promise<HookResult> { ... }
export async function runToolHook(hook: ToolHookDef, toolArgs: Record<string, unknown>, cwd: string): Promise<HookResult> { ... }
```

Template rendering uses a new inline `renderHookCommand` (supports `{{tool.arg}}` with dots). Does not reuse `renderTemplate` from runner to avoid complexity.

## Error Handling

- Hook timeout: 30s (matching startup-executor pattern).
- Hook failures return `{ success: false, stderr }` — never throw.
- Unknown `on_failure` values fall back to `warn`.
- `{{tool.arg}}` referencing non-existent arg → empty string.
- `on_stage_complete` rejection uses the existing `setGroupFeedback()` mechanism.

## Files Modified

| File | Change |
|------|--------|
| `contracts/src/pipeline.ts` | Add `StageHooks`, `StageHookDef`, `ToolHookDef`, `HookOnFailure`. Extend `StageDefinition`. |
| `contracts/src/runner-events.ts` | Add `onPreToolUse` and `onPostToolUse` to `RunnerCallbacks`. |
| `engine/src/pipeline/hook-executor.ts` | **New** — shell execution, template rendering for hooks. |
| `engine/src/pipeline/loader.ts` | Parse `hooks` from stage YAML into `StageDefinition`. |
| `engine/src/engine.ts` | Call hooks at `on_stage_start`, `on_stage_complete`; provide callbacks to `runAgent`. |
| `runner/src/runner.ts` | Honor `onPreToolUse` (block tool); call `onPostToolUse` (append to conversation). |

## Testing

- `engine/src/pipeline/hook-executor.test.ts` — unit: template rendering, success, failure behaviors.
- `engine/src/pipeline/loader.test.ts` — extend: verify `hooks` parsed from YAML.
- `runner/src/runner.test.ts` — extend: `onPreToolUse` blocking creates synthetic failed ToolCall.
- `engine/src/engine.test.ts` (or integration) — `on_stage_complete` with `on_failure: reject` produces `rejected` status.

## Acceptance Criteria

- [ ] A hook `on_stage_complete` with `on_failure: reject` runs `npx tsc --noEmit` and rejects the stage if it fails.
- [ ] A hook `post_tool_use` on `repo_manager-write_file` runs `npx prettier --write {{tool.path}}` automatically.
- [ ] Hook errors with `on_failure: reject` are injected into `group_feedback` so the coder receives them.
- [ ] STU-91 is resolved as a specific case of this system.
