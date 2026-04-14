# Design: POST /api/contracts/:name/validate (STU-146)

## Problem

There is no way to validate an arbitrary output against a saved contract via the API without actually running a pipeline. The CLI has `studio validate <contract> <output.json>` but nothing exposes this over HTTP. This endpoint fills that gap — useful for dashboards, debugging tools, and CI scripts that want to dry-run validation.

## Decision

**Approach A: new `validateOutput` engine helper + `POST /api/contracts/:name/validate` route.**

Rejected alternatives:
- Add `@studio-foundation/ralph` directly to api deps — violates the documented dep rule (api → engine + contracts), and api already has `@studio-foundation/runner` as an existing exception we shouldn't compound.
- Flat `POST /api/validate` with inline contract body — YAGNI, not needed by STU-146.

## Engine helper — `validateOutput`

New file: `engine/src/pipeline/output-validator.ts`

```typescript
import type { OutputContract, ToolCall } from '@studio-foundation/contracts';
import type { ValidationResult } from '@studio-foundation/contracts';
import {
  validateSchema, validateToolCalls, validateRequiredTools,
  validateCountedTools, validateToolGroups,
} from '@studio-foundation/ralph';
import { postValidate, type PostValidationResult } from './post-validator.js';

export interface OutputValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  post_validation: PostValidationResult;
}

export function validateOutput(
  contract: OutputContract,
  output: unknown,
  toolCalls: ToolCall[] = []
): OutputValidationResult {
  const results: ValidationResult[] = [
    validateSchema(output, contract),
    validateToolCalls(toolCalls, contract.tool_calls),
    validateRequiredTools(toolCalls, contract.tool_calls),
    validateCountedTools(toolCalls, contract.tool_calls),
    validateToolGroups(toolCalls, contract.tool_calls),
  ];

  const errors = results.flatMap(r => r.errors);
  const warnings = results.flatMap(r => r.warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    post_validation: postValidate(output, contract),
  };
}
```

Exported from `engine/src/index.ts`.

## API route

Added to `api/src/routes/contracts.ts` alongside existing CRUD.

```
POST /api/contracts/:name/validate
```

**Request body:**
```json
{
  "output": { "summary": "...", "files_changed": ["src/foo.ts"] },
  "tool_calls": [
    { "name": "repo_manager-write_file", "arguments": { "path": "src/foo.ts" }, "result": "ok" }
  ]
}
```
`tool_calls` is optional, defaults to `[]`.

**Response 200 (pass):**
```json
{
  "valid": true,
  "errors": [],
  "warnings": [],
  "post_validation": { "accepted": true }
}
```

**Response 200 (fail):**
```json
{
  "valid": false,
  "errors": ["Missing required field: summary"],
  "warnings": [],
  "post_validation": {
    "accepted": false,
    "rejection_reason": "Rejected: status = \"rejected\"",
    "rejection_details": ["Issue A"]
  }
}
```

**Response 404:** contract not found
**Response 400:** body not an object

HTTP 200 is always returned when the request is well-formed. `valid` carries the validation verdict. This is consistent with how validate-style endpoints work — the HTTP status reflects request success, not output correctness.

## Tests

### `engine/src/pipeline/output-validator.test.ts` (new)
- Missing required field → `valid: false`, correct error message
- All required fields present → `valid: true`
- `tool_calls.minimum: 1`, empty tool_calls → `valid: false`
- `tool_calls.minimum: 1`, tool_calls provided → `valid: true`
- Required tool missing → `valid: false`
- `post_validation` approved value → `post_validation.accepted: true`
- `post_validation` rejected value → `post_validation.accepted: false`, rejection_reason populated

### `api/tests/contracts.test.ts` (additions)
- Valid output, schema-only contract → 200 `{ valid: true }`
- Missing required field → 200 `{ valid: false, errors: [...] }`
- Contract with `tool_calls.minimum: 1`, no tool_calls → 200 `{ valid: false }`
- Contract with `tool_calls.minimum: 1`, tool_calls provided → 200 `{ valid: true }`
- Post-validation rejection → 200 `{ valid: true, post_validation: { accepted: false } }`
- Unknown contract name → 404

## Files touched

| File | Change |
|------|--------|
| `engine/src/pipeline/output-validator.ts` | New — `validateOutput` helper |
| `engine/src/pipeline/output-validator.test.ts` | New — unit tests |
| `engine/src/index.ts` | Export `validateOutput` and `OutputValidationResult` |
| `api/src/routes/contracts.ts` | Add `POST /contracts/:name/validate` handler |
| `api/tests/contracts.test.ts` | Add validate test cases |
