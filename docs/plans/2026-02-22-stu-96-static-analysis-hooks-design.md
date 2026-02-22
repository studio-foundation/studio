# STU-96: Hook post-codegen — Analyse statique avant QA (silent-failure detection)

**Date:** 2026-02-22
**Status:** Approved
**Depends on:** STU-94 (lifecycle hooks — done)

## Problem

The QA LLM reads code and can miss silent-failure patterns that static analysis catches deterministically: swallowed exceptions, implicit undefined returns, TypeScript type errors, unused imports. Running these checks after code-generation, before QA, filters obvious mechanical errors without involving an LLM.

## Goal

Add `on_stage_complete` hooks to the `code-generation` stage that run `tsc` and ESLint. If either fails, the stage is rejected and the compiler/linter stderr flows into `group_feedback` — the next code-gen iteration receives exact error output to fix.

## Design

### 1. Template System Extension (`hook-executor.ts`)

`renderHookCommand` gains an optional third parameter `outputContext`:

```typescript
export function renderHookCommand(
  command: string,
  toolArgs: Record<string, unknown>,
  outputContext: Record<string, unknown> = {}
): string
```

**New pattern:** `{{output.<field>}}` — looks up `outputContext[field]`. Arrays are space-joined for CLI compatibility (`['a.ts', 'b.ts']` → `'a.ts b.ts'`). Unknown fields → empty string. Existing `{{tool.<arg>}}` is unchanged.

`runStageHook` gains an optional `outputContext` parameter, forwarded to `renderHookCommand`. `runToolHook` is unchanged (no output context at tool boundary).

### 2. Engine Integration (`engine.ts`)

In the `on_stage_complete` hook loop, pass the last agent output as `outputContext`:

```typescript
const agentOutput = ralphResult.status === 'success'
  ? (ralphResult.result?.output as Record<string, unknown> ?? {})
  : {};
const hookResult = await runStageHook(hook, hookCwd, agentOutput);
```

The rejection flow is unchanged: stderr → `postResult.rejection_details` → `group_feedback` on next iteration.

### 3. YAML Configuration

Both pipeline fixtures receive hooks on `code-generation`:

```yaml
- name: code-generation
  kind: code_generation
  agent: coder
  contract: code-generation
  hooks:
    on_stage_complete:
      - command: "npx tsc --noEmit"
        on_failure: reject
      - command: "npx eslint --rule 'no-empty-catch: error' --rule 'no-unused-vars: warn' {{output.files_changed}}"
        on_failure: reject
  ralph: ...
```

`npx tsc --noEmit` — scans the whole project, no template vars needed.
`{{output.files_changed}}` — resolved from the stage output's `files_changed` field (list of written file paths).

Both hooks use `on_failure: reject` so compiler/linter failures reject the stage without stopping the pipeline (the group retries).

### 4. Testing

**Unit — `hook-executor.test.ts`:**
- `{{output.files_changed}}` with array → space-joined
- `{{output.files_changed}}` with string → as-is
- `{{output.unknown}}` → empty string
- `{{tool.path}}` unchanged (backward compat)
- Mixed `{{tool.path}} {{output.files_changed}}` in same command

**Integration — extend `engine.test.ts`:**
- Mocked hook fails (tsc error) → stage status `rejected`, `rejection_details` includes stderr
- Mocked hook passes → stage status `success`

No real tsc/eslint invocations in tests.

## Files Modified

| File | Change |
|------|--------|
| `engine/src/pipeline/hook-executor.ts` | Extend `renderHookCommand` + `runStageHook` with `outputContext` param |
| `engine/src/engine.ts` | Thread stage output into `runStageHook` in `on_stage_complete` loop |
| `engine/src/pipeline/hook-executor.test.ts` | Add `{{output.*}}` unit tests |
| `engine/tests/engine.test.ts` | Add integration tests for output-context rejection |
| `engine/tests/fixtures/software/pipelines/feature-builder.pipeline.yaml` | Add hooks to code-generation |
| `cli/templates/projects/software/pipelines/feature-builder.pipeline.yaml` | Same |

## Acceptance Criteria

- [ ] A TypeScript file with type errors → rejected before QA, stderr in group_feedback
- [ ] A file with `catch (e) {}` → rejected, lint output with line reference in group_feedback
- [ ] A clean file → passes both hooks, reaches QA normally
- [ ] Next code-gen iteration receives compiler/linter errors verbatim and can fix them
- [ ] `{{output.files_changed}}` with an array value → space-joined in the shell command
