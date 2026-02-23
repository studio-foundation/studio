# Design: Anti-théâtre — Exclude Failed Tool Calls from Minimum Count

**Date:** 2026-02-22
**Issue:** STU-121
**Packages touched:** `ralph`, `engine`

## Problem

`tool_calls.minimum` currently counts all tool calls including failed ones (ENOENT, permission denied, shell error, etc.). An agent can reach the required minimum by spamming `read_file` on non-existent files — exactly the theatre we want to detect.

Example: contract requires `minimum: 1`, agent makes 4 `read_file` calls → all ENOENT, 0 writes. Validation passes. Real work done = zero.

## Solution

Filter to successful tool calls before counting in all three validator functions. A call is successful if `ToolCall.error` is falsy.

Failed calls remain tracked in logs, events, and metrics — they just don't count toward the minimum.

## Approach

**Approach A: Filter in validators only.** No changes to types, runner, contracts, CLI, or persistence. The `ToolCall.error` field already distinguishes success from failure. Localized to ralph's validators + one call-site change in engine.

## Design

### Section 1: Helper + Validator Changes (`ralph/src/validator.ts`)

New internal helper:

```typescript
function isSuccessfulToolCall(tc: ToolCall): boolean {
  return !tc.error;
}
```

**`validateToolCalls` signature change:**

```typescript
// Before
export function validateToolCalls(toolCallsCount: number, requirements: ToolCallRequirements)

// After
export function validateToolCalls(toolCalls: ToolCall[], requirements: ToolCallRequirements)
// internally: const successfulCount = toolCalls.filter(isSuccessfulToolCall).length;
```

**`validateRequiredTools`:** Filter to successful calls before checking if a required tool name is present.

**`validateCountedTools`:** Filter to successful calls to counted tools before summing toward the minimum.

**Engine call-site (`engine/src/engine.ts` → `buildValidator`):** Change `validateToolCalls(result.tool_calls_count, ...)` to `validateToolCalls(result.tool_calls, ...)`.

No changes to: `ToolCall` type, `AgentRunResult` type, runner, contracts, CLI, events, or persistence.

### Section 2: Error Messages

Make it clear that only successful calls count, and include failed call context for retry prompts:

- **Minimum:** `"Expected at least 3 successful tool call(s), got 1 (2 failed calls excluded)"`
- **Required tool — all failed:** `"Required tool 'repo_manager-write_file' has no successful calls (called 2 times, all failed)"`
- **Required tool — never called:** unchanged — `"Required tool 'repo_manager-write_file' was not called"`

### Section 3: Test Cases

#### `validateToolCalls`

| Scenario | tool_calls | minimum | expected |
|---|---|---|---|
| All successful | 3 success, 0 failed | 1 | pass |
| All failed | 0 success, 4 failed | 1 | fail |
| Mixed, meets minimum | 1 success, 2 failed | 1 | pass |
| Mixed, under minimum | 1 success, 2 failed | 3 | fail |
| Zero calls | empty | 1 | fail |

#### `validateRequiredTools`

| Scenario | expected |
|---|---|
| Required tool called successfully | pass |
| Required tool called but all failed | fail |
| Required tool never called | fail |

#### `validateCountedTools`

| Scenario | expected |
|---|---|
| 2 success `write_file`, 1 failed `read_file`, counted: both, min 2 | pass |
| 1 success `write_file`, 2 failed `read_file`, counted: both, min 2 | fail |

#### Engine integration

One test verifying `buildValidator` passes `result.tool_calls` (not `result.tool_calls_count`) to the updated `validateToolCalls`.

## Acceptance Criteria (from STU-121)

- `tool_calls.minimum` only counts successful tool calls
- Failed tool calls still appear in logs and metrics
- Agent with N failed + 0 successful fails validation when minimum > 0
- Agent with 1 failed + 1 successful passes if minimum: 1
- `required_tools`: the required tool must have at least 1 successful call
