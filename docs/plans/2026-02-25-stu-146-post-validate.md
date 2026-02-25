# STU-146: POST /api/contracts/:name/validate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `POST /api/contracts/:name/validate` endpoint that validates an arbitrary output against a saved contract without running a pipeline.

**Architecture:** Add a `validateOutput` helper to `@studio/engine` that calls existing ralph validators + `postValidate`, export it from the engine barrel, then wire a new route handler in the API's existing contracts route file.

**Tech Stack:** TypeScript, `@studio/ralph` (validators), `@studio/engine` (postValidate, loadContract), Fastify (route), Vitest (tests)

---

### Task 1: Write failing unit tests for `validateOutput`

**Files:**
- Create: `engine/src/pipeline/output-validator.test.ts`

**Step 1: Create the test file**

```typescript
// engine/src/pipeline/output-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateOutput } from './output-validator.js';
import type { OutputContract } from '@studio/contracts';

const schemaOnlyContract: OutputContract = {
  name: 'test-schema',
  version: 1,
  schema: { required_fields: ['summary', 'files_changed'] },
};

const toolCallContract: OutputContract = {
  name: 'test-tool-calls',
  version: 1,
  schema: { required_fields: ['summary'] },
  tool_calls: { minimum: 1, required_tools: ['repo_manager-write_file'] },
};

const postValidationContract: OutputContract = {
  name: 'test-post-validation',
  version: 1,
  schema: { required_fields: ['status'] },
  post_validation: {
    rejection_detection: {
      field: 'status',
      approved_values: ['approved'],
      rejected_values: ['rejected'],
    },
  },
};

describe('validateOutput', () => {
  describe('schema validation', () => {
    it('returns valid: true when all required fields are present', () => {
      const result = validateOutput(schemaOnlyContract, { summary: 'ok', files_changed: ['a.ts'] });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.post_validation.accepted).toBe(true);
    });

    it('returns valid: false with error when required field is missing', () => {
      const result = validateOutput(schemaOnlyContract, { summary: 'ok' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: files_changed');
    });

    it('returns valid: false when output is not an object', () => {
      const result = validateOutput(schemaOnlyContract, 'not an object');
      expect(result.valid).toBe(false);
    });
  });

  describe('tool_calls validation', () => {
    it('returns valid: false when minimum not met (empty tool_calls)', () => {
      const result = validateOutput(toolCallContract, { summary: 'ok' }, []);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('tool call'))).toBe(true);
    });

    it('returns valid: false when required tool was not called', () => {
      const result = validateOutput(
        toolCallContract,
        { summary: 'ok' },
        [{ name: 'shell-run_command', arguments: {}, result: 'ok' }]
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('repo_manager-write_file'))).toBe(true);
    });

    it('returns valid: true when required tool was called successfully', () => {
      const result = validateOutput(
        toolCallContract,
        { summary: 'ok' },
        [{ name: 'repo_manager-write_file', arguments: { path: 'a.ts' }, result: 'ok' }]
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe('post_validation', () => {
    it('accepted: true when approved value present', () => {
      const result = validateOutput(postValidationContract, { status: 'approved' });
      expect(result.valid).toBe(true);
      expect(result.post_validation.accepted).toBe(true);
    });

    it('accepted: false with rejection_reason when rejected value present', () => {
      const result = validateOutput(postValidationContract, { status: 'rejected' });
      expect(result.post_validation.accepted).toBe(false);
      expect(result.post_validation.rejection_reason).toBeTruthy();
    });

    it('post_validation runs independently of schema validity', () => {
      // Schema fails (missing status) but post_validation still runs on what's there
      const result = validateOutput(
        { ...postValidationContract, schema: { required_fields: ['summary', 'status'] } },
        { status: 'rejected' }
      );
      expect(result.valid).toBe(false); // missing 'summary'
      expect(result.post_validation.accepted).toBe(false); // status: rejected
    });
  });
});
```

**Step 2: Run to confirm it fails**

```bash
cd /path/to/worktree
pnpm --filter @studio/engine test
```

Expected: `FAIL — cannot find module './output-validator.js'`

**Step 3: Commit the test**

```bash
git add engine/src/pipeline/output-validator.test.ts
git commit -m "test(engine): failing tests for validateOutput helper"
```

---

### Task 2: Implement `validateOutput` to make tests pass

**Files:**
- Create: `engine/src/pipeline/output-validator.ts`

**Step 1: Create the implementation**

```typescript
// engine/src/pipeline/output-validator.ts
import type { OutputContract, ToolCall } from '@studio/contracts';
import {
  validateSchema,
  validateToolCalls,
  validateRequiredTools,
  validateCountedTools,
  validateToolGroups,
} from '@studio/ralph';
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
  const results = [
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

**Step 2: Run tests**

```bash
pnpm --filter @studio/engine test
```

Expected: all tests in `output-validator.test.ts` PASS

**Step 3: Commit**

```bash
git add engine/src/pipeline/output-validator.ts
git commit -m "feat(engine): validateOutput helper — full contract validation without a run"
```

---

### Task 3: Export from engine barrel + build

**Files:**
- Modify: `engine/src/index.ts`

**Step 1: Add exports**

In `engine/src/index.ts`, find the `// Pipeline loaders` block and add after it:

```typescript
// Contract validation
export { validateOutput } from './pipeline/output-validator.js';
export type { OutputValidationResult } from './pipeline/output-validator.js';
export type { PostValidationResult } from './pipeline/post-validator.js';
```

**Step 2: Build the engine package**

```bash
pnpm --filter @studio/engine build
```

Expected: no TypeScript errors

**Step 3: Commit**

```bash
git add engine/src/index.ts
git commit -m "feat(engine): export validateOutput and OutputValidationResult"
```

---

### Task 4: Write failing API integration tests for the validate route

**Files:**
- Modify: `api/tests/contracts.test.ts`

**Step 1: Add a contract fixture with tool_calls and post_validation to `beforeAll`**

In the existing `beforeAll` block in `api/tests/contracts.test.ts`, add two more `writeFileSync` calls:

```typescript
writeFileSync(
  resolve(CONTRACTS_DIR, 'with-tool-calls.contract.yaml'),
  [
    'name: with-tool-calls',
    'version: 1',
    'schema:',
    '  required_fields:',
    '    - summary',
    'tool_calls:',
    '  minimum: 1',
  ].join('\n')
);

writeFileSync(
  resolve(CONTRACTS_DIR, 'with-post-validation.contract.yaml'),
  [
    'name: with-post-validation',
    'version: 1',
    'schema:',
    '  required_fields:',
    '    - status',
    'post_validation:',
    '  rejection_detection:',
    '    field: status',
    '    approved_values:',
    '      - approved',
    '    rejected_values:',
    '      - rejected',
  ].join('\n')
);
```

**Step 2: Add the new describe block at the end of the file**

```typescript
describe('POST /api/contracts/:name/validate', () => {
  it('returns valid: true for a correct output against schema-only contract', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/brief-analysis/validate',
      payload: { output: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { valid: boolean; errors: string[]; warnings: string[] };
    expect(body.valid).toBe(true);
    expect(body.errors).toEqual([]);
  });

  it('returns valid: false with error when required field missing', async () => {
    const server = makeServer();
    // brief-analysis has no required_fields, use code-generation which has tool_calls.minimum:1
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/with-tool-calls/validate',
      payload: { output: { summary: 'ok' }, tool_calls: [] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { valid: boolean; errors: string[] };
    expect(body.valid).toBe(false);
    expect(body.errors.some((e: string) => e.includes('tool call'))).toBe(true);
  });

  it('returns valid: true when tool_calls requirement met', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/with-tool-calls/validate',
      payload: {
        output: { summary: 'ok' },
        tool_calls: [{ name: 'repo_manager-write_file', arguments: { path: 'a.ts' }, result: 'ok' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { valid: boolean };
    expect(body.valid).toBe(true);
  });

  it('post_validation: accepted: false when rejected value', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/with-post-validation/validate',
      payload: { output: { status: 'rejected' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      valid: boolean;
      post_validation: { accepted: boolean; rejection_reason: string };
    };
    expect(body.valid).toBe(true); // schema is fine
    expect(body.post_validation.accepted).toBe(false);
    expect(body.post_validation.rejection_reason).toBeTruthy();
  });

  it('post_validation: accepted: true when approved value', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/with-post-validation/validate',
      payload: { output: { status: 'approved' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { post_validation: { accepted: boolean } };
    expect(body.post_validation.accepted).toBe(true);
  });

  it('returns 404 for unknown contract', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/nonexistent/validate',
      payload: { output: {} },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('Contract not found');
  });

  it('returns 400 when output field is missing from body', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/brief-analysis/validate',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
```

**Step 3: Run to confirm tests fail**

```bash
pnpm --filter @studio/api test
```

Expected: new `POST /api/contracts/:name/validate` tests FAIL (route doesn't exist yet — likely 404s)

**Step 4: Commit the tests**

```bash
git add api/tests/contracts.test.ts
git commit -m "test(api): failing integration tests for POST /contracts/:name/validate"
```

---

### Task 5: Implement the API route handler

**Files:**
- Modify: `api/src/routes/contracts.ts`

**Step 1: Add the import at the top of the file**

After the existing imports in `api/src/routes/contracts.ts`, add:

```typescript
import { loadContract, validateOutput } from '@studio/engine';
```

(`loadContract` here is `engine/src/pipeline/contract-loader.ts`'s version, already exported from engine.)

**Step 2: Add the route handler inside `contractsRoutes`**

Add this after the `DELETE /api/contracts/:name` handler, before the closing `}`:

```typescript
  // POST /api/contracts/:name/validate
  fastify.post<{
    Params: { name: string };
    Body: { output: unknown; tool_calls?: unknown[] };
  }>('/contracts/:name/validate', {
    schema: {
      tags: ['contracts'],
      summary: 'Validate an output against a contract without running a pipeline',
      params: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      body: {
        type: 'object',
        required: ['output'],
        properties: {
          output: { type: 'object', additionalProperties: true },
          tool_calls: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                arguments: { type: 'object', additionalProperties: true },
                result: {},
                error: { type: 'string' },
              },
              required: ['name'],
            },
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            valid: { type: 'boolean' },
            errors: { type: 'array', items: { type: 'string' } },
            warnings: { type: 'array', items: { type: 'string' } },
            post_validation: {
              type: 'object',
              properties: {
                accepted: { type: 'boolean' },
                rejection_reason: { type: 'string' },
                rejection_details: { type: 'array', items: { type: 'string' } },
              },
              required: ['accepted'],
            },
          },
          required: ['valid', 'errors', 'warnings', 'post_validation'],
        },
        400: errorSchema,
        404: errorSchema,
      },
    },
  }, async (request, reply) => {
    let contract;
    try {
      contract = await loadContract(request.params.name, contractsDir);
    } catch {
      return reply.status(404).send({ error: 'Contract not found' });
    }

    const { output, tool_calls = [] } = request.body;
    const result = validateOutput(contract, output, tool_calls as import('@studio/contracts').ToolCall[]);
    return reply.send(result);
  });
```

**Step 3: Run the API tests**

```bash
pnpm --filter @studio/api test
```

Expected: all tests PASS including the new validate block

**Step 4: Build everything**

```bash
pnpm build
```

Expected: no TypeScript errors across all packages

**Step 5: Commit**

```bash
git add api/src/routes/contracts.ts
git commit -m "feat(api): POST /contracts/:name/validate — validate output without a run (STU-146)"
```

---

### Task 6: Final verification

**Step 1: Run the full test suite**

```bash
pnpm test
```

Expected: all tests pass across all packages

**Step 2: If all green, push and open PR**

Use the `commit-commands:commit-push-pr` skill or:

```bash
git push -u origin <branch-name>
gh pr create \
  --title "feat(api): POST /contracts/:name/validate — validate without a run (STU-146)" \
  --body "$(cat <<'EOF'
## What

Adds `POST /api/contracts/:name/validate` endpoint.

Validates an arbitrary output against a saved contract without running a pipeline — schema, tool calls, and post_validation (rejection detection) all checked.

## Why

STU-146. Needed for dashboards, debugging tools, and CI scripts that want to dry-run contract validation.

## Packages touched

- `engine`: new `validateOutput` helper in `pipeline/output-validator.ts`, exported from barrel
- `api`: new route handler in `routes/contracts.ts`

## How to test

```bash
pnpm test
# or manually:
curl -X POST http://localhost:3000/api/contracts/brief-analysis/validate \
  -H "Content-Type: application/json" \
  -d '{"output": {"summary": "done"}}'
```
EOF
)" \
  --base main
```
