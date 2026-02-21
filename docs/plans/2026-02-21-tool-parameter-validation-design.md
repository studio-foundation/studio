# Tool Parameter Validation — Design

**Date:** 2026-02-21
**Status:** Approved

## Problem

When a user adds a custom tool YAML (e.g. `web-search.tool.yaml`) with a shell command that uses `{{query}}`, but the LLM later calls that tool with a parameter named `pattern`, two things go wrong silently:

1. The shell command substitutes an empty string for `{{query}}` — the tool runs but produces garbage
2. The CLI display shows `web_search-search("undefined")` — confusing to the user

There is currently no validation layer between the YAML definition and tool execution.

## Approach: Two-layer validation in existing modules

### Layer 1 — Load-time YAML consistency check

**Location:** `runner/src/tools/plugin-loader.ts`

After parsing each `.tool.yaml`, before registering any tool, validate shell command templates:

1. Extract all `{{placeholder}}` names from the command string (regex `\{\{(\w+)\}\}`, ignoring `#if`, `else`, `/if`, and filter keywords like `join`, `json`)
2. Diff against the declared `parameters` keys
3. Any placeholder not declared → throw `ToolYamlError`

**Error format:**
```
ToolYamlError: web-search.tool.yaml › command 'web_search-search':
  template uses {{search_query}} but no such parameter is declared.
  Declared parameters: query
```

This error surfaces before the LLM runs (stage startup aborts).

**New class:** `ToolYamlError extends Error` — lives in `runner/src/tools/` (internal runner concern, not in `contracts`).

### Layer 2 — Execution-time argument validation

**Location:** `runner/src/tools/tool-executor.ts`, in `ToolExecutor.execute()`, before calling `tool.execute(args)`

For each LLM tool call, validate against the tool's parameter schema:

1. **Missing required params** — parameter declared `required: true` absent from LLM arguments:
   ```
   Tool web_search-search: missing required parameter 'query'
   ```
2. **Unknown params** — key in LLM arguments not declared in `parameters`:
   ```
   Tool web_search-search: unknown parameter 'pattern' (declared: query)
   ```

Returned as a failed `ToolCall` (not a throw) — the LLM receives the error as feedback in its next turn. The stage fails through RALPH normally.

The `Tool` object already carries the parameter schema; no new data flow is needed.

## What is NOT in scope

- Type validation (string vs number) — the JSON Schema sent to the LLM already encodes this; enforcing it at runtime is YAGNI for now
- Builtin tools — they are TypeScript functions with their own type safety; YAML consistency check only applies to `execute.type: shell`

## Files touched

| File | Change |
|------|--------|
| `runner/src/tools/plugin-loader.ts` | Add template placeholder extraction + diff after YAML parse |
| `runner/src/tools/tool-executor.ts` | Add required/unknown param check before `tool.execute()` |
| `runner/src/tools/errors.ts` (new) | `ToolYamlError` class |
| Tests in `runner/src/tools/__tests__/` | Unit tests for both layers |
