# Design: STU-47 — `studio run` Input Wizard (Phase 1)

**Date:** 2026-02-18
**Status:** Approved
**Linear:** STU-47

## Problem

Running a pipeline with structured input requires either:
- `--input "..."` with raw JSON (unreadable for complex inputs)
- `--input-file path.yaml` with a manually created file (extra friction)

Users shouldn't need to know `.studio/` internals to run a pipeline.

## Solution

Add an interactive wizard to `studio run` that collects structured input when the pipeline declares an `input_schema`. Falls back to existing behavior when no schema is declared.

## Approach

**Approach A — Minimal refactor.** Load the pipeline early in `run.ts` (before input resolution), insert wizard detection inline, and implement the wizard in a new `cli/src/utils/input-wizard.ts`. The engine loader is untouched — `input_schema` flows through the existing `...parsed` spread.

## Design

### 1. Types (`contracts/src/pipeline.ts`)

```typescript
export interface InputField {
  name: string;
  type: 'text' | 'array';
  prompt: string;
  required: boolean;
  default?: string;
  items?: 'text'; // Phase 1: only text items for arrays
}

export interface InputSchema {
  type: 'structured';
  fields: InputField[];
}

// PipelineDefinition gets one new optional field:
export interface PipelineDefinition {
  // ...existing fields unchanged...
  input_schema?: InputSchema;
}
```

The engine's `parsePipelineYaml` is untouched — `input_schema` passes through via `...parsed` spread. Validation is CLI-only.

### 2. Wizard (`cli/src/utils/input-wizard.ts`) — new file

Two exported functions:

**`validateInputSchema(schema: unknown): InputSchema`**
Validates the raw parsed YAML value. Throws descriptive errors if:
- `fields` is missing or empty
- any field is missing `prompt`
- `type` is not `'text'` or `'array'`
- field is `array` but `items` is not `'text'`

**`collectStructuredInput(schema: InputSchema): Promise<Record<string, unknown>>`**
Runs interactive prompts using `@inquirer/prompts` (already a dependency):
- `text` field → single `input()` with `required` and `default` support
- `array` field → loop of `input()` calls until empty entry; requires at least 1 entry if `required: true`
- prints `✓ Input collected` after completion

### 3. `run.ts` refactor

Pipeline loaded unconditionally early (before input resolution):

```
configsDir resolved → pipelinesDir computed → pipeline loaded
```

Input resolution priority (wizard branch inserted):

```
--input-file   → load YAML file, skip wizard
--input        → use string, skip wizard
input_schema   → validate schema, launch wizard
(none)         → error: "Pipeline requires input. Use --input or --input-file."
```

The existing repo-URL logic reuses the already-loaded `PipelineDefinition` instead of loading it a second time.

### 4. Template update

Add example `input_schema` to the software template pipeline:

```yaml
# cli/templates/projects/software/project/pipelines/feature-builder.pipeline.yaml
input_schema:
  type: structured
  fields:
    - name: brief_summary
      type: text
      required: true
      prompt: "Brief summary"
    - name: acceptance_criteria
      type: array
      items: text
      prompt: "Acceptance criteria"
```

### 5. Tests (`cli/tests/utils/input-wizard.test.ts`) — new file

Unit tests for pure logic (no real terminal prompts):

- `validateInputSchema` — valid schema passes; invalid schemas throw with clear messages
  - empty `fields` array
  - field missing `prompt`
  - field with invalid `type`
  - `array` field without `items: 'text'`
- `collectStructuredInput` — prompts mocked via `vi.mock('@inquirer/prompts')`
  - `text` field returns correct value
  - `array` field collects multiple values until empty string

The existing `cli/tests/commands/run.test.ts` remains `describe.skip` (full engine mocking is out of scope).

## Behavior Matrix

| Condition | Behavior |
|-----------|----------|
| `--input-file` provided | Load file, skip wizard |
| `--input` provided | Use string, skip wizard |
| `input_schema` present, no flags | Validate schema, launch wizard |
| No `input_schema`, no flags | Error: "Pipeline requires input. Use --input or --input-file." |
| `input_schema` + `--input` | Use `--input`, ignore schema |

## Files Changed

| File | Change |
|------|--------|
| `contracts/src/pipeline.ts` | Add `InputField`, `InputSchema`, extend `PipelineDefinition` |
| `cli/src/utils/input-wizard.ts` | New — `validateInputSchema` + `collectStructuredInput` |
| `cli/src/commands/run.ts` | Load pipeline early, add wizard detection branch |
| `cli/templates/projects/software/project/pipelines/feature-builder.pipeline.yaml` | Add example `input_schema` |
| `cli/tests/utils/input-wizard.test.ts` | New — unit tests |

## Out of Scope (Phase 2)

- Field types: `select`, `multiselect`, `number`, `confirm`, `date`
- Advanced validation: regex, min/max, custom validators
- Conditional fields
- Input schema in a separate file
- Review/edit before submit
