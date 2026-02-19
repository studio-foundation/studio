# Design: Live Streaming Tool Calls (`--live`) — STU-44

**Date:** 2026-02-19
**Status:** Approved
**Linear:** STU-44

## Overview

Add `--live` flag to `studio run` that streams tool calls to the terminal in real time — each tool call appears with a spinner as it executes, resolving to a result summary when done. Like Claude Code's live tool display.

Three display modes after this change:
- `quiet` (default) — stage-level only, unchanged from STU-37
- `--verbose` — stage + grouped tool call summary, unchanged from STU-37
- `--live` — stage header + individual tool call spinners in real time (new)

## Architecture

### Event flow

```
CLI creates EngineEvents (with onToolCallStart/Complete)
  ↓
PipelineEngine stores this.events
  ↓
Engine passes RunnerCallbacks { onToolCallStart, onToolCallComplete } to runAgent()
  ↓
runAgent() fires them before/after each toolExecutor.execute()
  ↓
CLI handlers update terminal immediately
```

### Dependency constraint

Runner cannot import from engine (forbidden inverse dependency). Solution: define the two new event types and `RunnerCallbacks` in `@studio/contracts` (the leaf package everyone can import). `EngineEvents` in `engine` adds the two new callbacks using those types.

## Files Changed

| File | Change |
|------|--------|
| `contracts/src/index.ts` | Add `ToolCallStartEvent`, `ToolCallCompleteEvent`, `RunnerCallbacks` |
| `engine/src/events.ts` | Add `onToolCallStart`, `onToolCallComplete` to `EngineEvents` |
| `engine/src/engine.ts` | Pass `callbacks` to `runAgent()` |
| `runner/src/runner.ts` | Accept `callbacks` in `RunAgentConfig`, call around tool execution (both paths) |
| `cli/src/commands/run.ts` | Add `--live` flag, `displayMode` logic, warning |
| `cli/src/output/progress.ts` | `displayMode` constructor arg, live rendering, new event handlers |
| `cli/src/output/formatters.ts` | Add `getToolIcon`, `summarizeToolParams`, `summarizeToolResult` |

## Detailed Design

### 1. New types in `@studio/contracts`

```typescript
export interface ToolCallStartEvent {
  tool: string;
  params: Record<string, unknown>;
  timestamp: string;
}

export interface ToolCallCompleteEvent {
  tool: string;
  result: unknown;
  error?: string;
  duration_ms: number;
  timestamp: string;
}

export interface RunnerCallbacks {
  onToolCallStart?: (event: ToolCallStartEvent) => void;
  onToolCallComplete?: (event: ToolCallCompleteEvent) => void;
}
```

### 2. `engine/src/events.ts` — extend EngineEvents

```typescript
import type { ToolCallStartEvent, ToolCallCompleteEvent } from '@studio/contracts';

export interface EngineEvents {
  // ...existing...
  onToolCallStart?: (event: ToolCallStartEvent) => void;
  onToolCallComplete?: (event: ToolCallCompleteEvent) => void;
}
```

### 3. `engine/src/engine.ts` — pass callbacks to runAgent

```typescript
const result = await runAgent({
  // ...existing fields...
  callbacks: this.events ? {
    onToolCallStart: this.events.onToolCallStart,
    onToolCallComplete: this.events.onToolCallComplete,
  } : undefined,
});
```

### 4. `runner/src/runner.ts` — emit callbacks around tool execution

Add to `RunAgentConfig`:
```typescript
import type { RunnerCallbacks } from '@studio/contracts';

export interface RunAgentConfig {
  // ...existing...
  callbacks?: RunnerCallbacks;
}
```

In the agent-loop path (inside the `provider.runAgentLoop` callback):
```typescript
async (name, args, callId) => {
  const start = Date.now();
  config.callbacks?.onToolCallStart?.({
    tool: name, params: args, timestamp: new Date().toISOString()
  });

  const executed = await toolExecutor.execute({ id: callId, name, arguments: args });
  allToolCalls.push(executed);

  config.callbacks?.onToolCallComplete?.({
    tool: name,
    result: executed.result,
    error: executed.error,
    duration_ms: Date.now() - start,
    timestamp: new Date().toISOString(),
  });

  // ...existing anonymization + return...
}
```

In the standard multi-turn loop (inside `for (const tc of response.tool_calls)`):
```typescript
const start = Date.now();
config.callbacks?.onToolCallStart?.({
  tool: tc.name, params: tc.arguments, timestamp: new Date().toISOString()
});

const executed = await toolExecutor.execute({ id: tc.id, name: tc.name, arguments: tc.arguments });
executedToolCalls.push(executed);
allToolCalls.push(executed);

config.callbacks?.onToolCallComplete?.({
  tool: tc.name,
  result: executed.result,
  error: executed.error,
  duration_ms: Date.now() - start,
  timestamp: new Date().toISOString(),
});
```

### 5. `cli/src/commands/run.ts` — `--live` flag and display mode

```typescript
interface RunOptions {
  // ...existing...
  live?: boolean;
}

// In runCommand():
const verbose = !!options.verbose;
const live = !!options.live;

if (verbose && live) {
  console.warn(chalk.yellow('⚠ Warning: --live includes all --verbose output. Ignoring --verbose.\n'));
}

const displayMode = live ? 'live' : verbose ? 'verbose' : 'quiet';
const progress = new ProgressDisplay(!!options.json, displayMode);
```

### 6. `cli/src/output/progress.ts` — live rendering

Constructor changes from `verbose: boolean` to `displayMode: 'quiet' | 'verbose' | 'live'`.

Key behavioral changes in live mode:
- `onStageStart`: prints a plain line instead of starting an ora spinner
- `onToolCallStart`: starts a per-tool ora spinner (indent: 2)
- `onToolCallComplete`: resolves the tool spinner with result summary (✓ or ✗)
- `onStageComplete`: prints a plain completion line instead of stopping a spinner

Since tool calls are sequential in the runner, there is never more than one active tool spinner. A single `toolSpinner: Ora | null` field suffices.

### 7. `cli/src/output/formatters.ts` — new helpers

```typescript
export function getToolIcon(tool: string): string {
  if (tool.startsWith('repo_manager-read')) return '📖';
  if (tool.startsWith('repo_manager-write')) return '✏️';
  if (tool.startsWith('repo_manager-list')) return '📁';
  if (tool.startsWith('search')) return '🔍';
  if (tool.startsWith('shell')) return '⚙️';
  if (tool.startsWith('git')) return '🔀';
  return '🔧';
}

export function summarizeToolParams(tool: string, params: Record<string, unknown>): string {
  if (tool.includes('read_file') || tool.includes('write_file')) return `(${params.path})`;
  if (tool.includes('list_files')) return params.path ? `(${params.path})` : '';
  if (tool.includes('search')) return `("${params.query}")`;
  if (tool.includes('run_command')) return `("${params.command}")`;
  return '';
}

export function summarizeToolResult(result: unknown, error?: string): string {
  if (error) return error;
  if (typeof result === 'string') {
    const lines = result.split('\n').length;
    return lines > 1 ? `${lines} lines` : result.slice(0, 60);
  }
  if (Array.isArray(result)) return `${result.length} items`;
  return 'Done';
}
```

## Edge Cases

- **Tool call error:** `onToolCallComplete` always fires with `error` set. Spinner shows ✗ + error message.
- **Ctrl+C:** No special handling — ora cleans up the terminal line on process exit.
- **Retry:** Tool call events from previous attempt have all resolved. New attempt emits fresh events. `onTaskRetry` display unchanged.
- **`--json` mode:** All handlers guard on `this.jsonMode` (unchanged).
- **JSONL logs:** Unaffected — no new log entries for individual tool calls.

## Terminal Output (live mode)

```
Running pipeline: software/feature-builder
Run ID: abc-123

[1/4] Analyzing brief...
  ⠋ 📖 repo_manager-read_file(src/pages/about.tsx)
  ✓ 247 lines
  ⠋ 📖 repo_manager-read_file(src/components/Card.tsx)
  ✓ 83 lines
  ⠋ 🔍 search-search_codebase("Accordion")
  ✓ No results
  ✓ (1 attempt, 42s)
  Requirements extracted for FAQ section

[2/4] ...
```
