# STU-47: `studio run` Input Wizard (Phase 1) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an interactive wizard to `studio run` that collects structured input from the user when the pipeline declares an `input_schema`, eliminating the need to manually craft `--input` JSON or create `.input.yaml` files.

**Architecture:** Add `InputSchema` / `InputField` types to `contracts`, implement validation + prompt collection in a new `cli/src/utils/input-wizard.ts`, then refactor `run.ts` to load the pipeline early and branch into the wizard when no `--input`/`--input-file` flag is provided.

**Tech Stack:** TypeScript, `@inquirer/prompts` (already in `cli/package.json`), vitest, `js-yaml`

---

### Task 1: Add `InputSchema` and `InputField` types to contracts

**Files:**
- Modify: `contracts/src/pipeline.ts`

No tests needed — this is pure type additions. The engine loader passes unknown extra fields through via `...parsed` spread, so no engine changes are required.

**Step 1: Add the types before `PipelineDefinition`**

Open `contracts/src/pipeline.ts`. Insert the following two interfaces at the top, after the existing import:

```typescript
export interface InputField {
  name: string;
  type: 'text' | 'array';
  prompt: string;
  required: boolean;
  default?: string;
  items?: 'text';
}

export interface InputSchema {
  type: 'structured';
  fields: InputField[];
}
```

**Step 2: Add `input_schema` to `PipelineDefinition`**

In the `PipelineDefinition` interface, add one optional field:

```typescript
export interface PipelineDefinition {
  name: string;
  description: string;
  version: number;
  input_schema?: InputSchema;   // ← add this line
  repo?: {
    url: string;
    branch?: string;
  };
  stages: PipelineEntry[];
}
```

**Step 3: Build and typecheck**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm build
```

Expected: Build succeeds with no errors.

**Step 4: Commit**

```bash
git add contracts/src/pipeline.ts
git commit -m "feat(contracts): add InputSchema and InputField types to PipelineDefinition"
```

---

### Task 2: Write failing tests for `validateInputSchema`

**Files:**
- Create: `cli/tests/utils/input-wizard.test.ts`

**Step 1: Create the test file**

```typescript
// cli/tests/utils/input-wizard.test.ts
import { describe, it, expect } from 'vitest';
import { validateInputSchema } from '../../src/utils/input-wizard.js';

describe('validateInputSchema', () => {
  it('accepts a valid text field', () => {
    const result = validateInputSchema({
      type: 'structured',
      fields: [{ name: 'brief_summary', type: 'text', prompt: 'Brief summary', required: true }],
    });
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].name).toBe('brief_summary');
  });

  it('accepts a valid array field', () => {
    const result = validateInputSchema({
      type: 'structured',
      fields: [{ name: 'criteria', type: 'array', items: 'text', prompt: 'Criteria', required: true }],
    });
    expect(result.fields[0].type).toBe('array');
  });

  it('accepts an optional field with a default', () => {
    const result = validateInputSchema({
      type: 'structured',
      fields: [{ name: 'page', type: 'text', prompt: 'Target page', required: false, default: 'src/index.ts' }],
    });
    expect(result.fields[0].default).toBe('src/index.ts');
  });

  it('throws when fields is missing', () => {
    expect(() => validateInputSchema({ type: 'structured' })).toThrow(
      'input_schema must have at least one field'
    );
  });

  it('throws when fields is empty', () => {
    expect(() => validateInputSchema({ type: 'structured', fields: [] })).toThrow(
      'input_schema must have at least one field'
    );
  });

  it('throws when a field is missing prompt', () => {
    expect(() =>
      validateInputSchema({
        type: 'structured',
        fields: [{ name: 'foo', type: 'text', required: true }],
      })
    ).toThrow("Field 'foo' must have a non-empty 'prompt'");
  });

  it('throws when a field has empty prompt', () => {
    expect(() =>
      validateInputSchema({
        type: 'structured',
        fields: [{ name: 'foo', type: 'text', prompt: '  ', required: true }],
      })
    ).toThrow("Field 'foo' must have a non-empty 'prompt'");
  });

  it('throws when a field has invalid type', () => {
    expect(() =>
      validateInputSchema({
        type: 'structured',
        fields: [{ name: 'foo', type: 'number', prompt: 'Foo', required: true }],
      })
    ).toThrow("Field 'foo' has invalid type 'number'. Must be 'text' or 'array'");
  });

  it('throws when an array field is missing items', () => {
    expect(() =>
      validateInputSchema({
        type: 'structured',
        fields: [{ name: 'foo', type: 'array', prompt: 'Foo', required: true }],
      })
    ).toThrow("Array field 'foo' must have items: 'text'");
  });

  it('throws when an array field has non-text items', () => {
    expect(() =>
      validateInputSchema({
        type: 'structured',
        fields: [{ name: 'foo', type: 'array', items: 'number', prompt: 'Foo', required: true }],
      })
    ).toThrow("Array field 'foo' must have items: 'text'");
  });
});
```

**Step 2: Run the tests to confirm they fail**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm --filter @studio-foundation/cli test
```

Expected: Tests fail with `Cannot find module '../../src/utils/input-wizard.js'`.

---

### Task 3: Implement `validateInputSchema`

**Files:**
- Create: `cli/src/utils/input-wizard.ts`

**Step 1: Create the file with `validateInputSchema`**

```typescript
// cli/src/utils/input-wizard.ts
import { input } from '@inquirer/prompts';
import type { InputSchema, InputField } from '@studio-foundation/contracts';

export function validateInputSchema(raw: unknown): InputSchema {
  const schema = raw as Record<string, unknown>;

  if (!Array.isArray(schema?.fields) || schema.fields.length === 0) {
    throw new Error('input_schema must have at least one field');
  }

  for (const field of schema.fields as any[]) {
    const name = field.name ?? '(unnamed)';

    if (!field.prompt || typeof field.prompt !== 'string' || !field.prompt.trim()) {
      throw new Error(`Field '${name}' must have a non-empty 'prompt'`);
    }

    if (field.type !== 'text' && field.type !== 'array') {
      throw new Error(
        `Field '${name}' has invalid type '${field.type}'. Must be 'text' or 'array'`
      );
    }

    if (field.type === 'array' && field.items !== 'text') {
      throw new Error(`Array field '${name}' must have items: 'text'`);
    }
  }

  return raw as InputSchema;
}

export async function collectStructuredInput(
  schema: InputSchema
): Promise<Record<string, unknown>> {
  // Implemented in Task 5
  throw new Error('not implemented');
}
```

**Step 2: Run the `validateInputSchema` tests**

```bash
pnpm --filter @studio-foundation/cli test
```

Expected: All `validateInputSchema` tests pass. The `collectStructuredInput` tests (Task 4) will fail — that's fine.

**Step 3: Commit**

```bash
git add cli/src/utils/input-wizard.ts cli/tests/utils/input-wizard.test.ts
git commit -m "feat(cli): add validateInputSchema with full test coverage"
```

---

### Task 4: Write failing tests for `collectStructuredInput`

**Files:**
- Modify: `cli/tests/utils/input-wizard.test.ts`

**Step 1: Add the `collectStructuredInput` test suite to the existing test file**

Append to `cli/tests/utils/input-wizard.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { collectStructuredInput } from '../../src/utils/input-wizard.js';

// Mock @inquirer/prompts at module level
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
}));

describe('collectStructuredInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('collects a single text field', async () => {
    const { input: mockInput } = await import('@inquirer/prompts');
    (mockInput as ReturnType<typeof vi.fn>).mockResolvedValueOnce('Add dark mode');

    const schema: InputSchema = {
      type: 'structured',
      fields: [{ name: 'brief_summary', type: 'text', prompt: 'Brief summary', required: true }],
    };

    const result = await collectStructuredInput(schema);

    expect(result).toEqual({ brief_summary: 'Add dark mode' });
    expect(mockInput).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Brief summary' })
    );
  });

  it('collects an array field with multiple entries', async () => {
    const { input: mockInput } = await import('@inquirer/prompts');
    (mockInput as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('First criterion')
      .mockResolvedValueOnce('Second criterion')
      .mockResolvedValueOnce('');  // empty → stop

    const schema: InputSchema = {
      type: 'structured',
      fields: [{ name: 'criteria', type: 'array', items: 'text', prompt: 'Criteria', required: true }],
    };

    const result = await collectStructuredInput(schema);

    expect(result).toEqual({ criteria: ['First criterion', 'Second criterion'] });
  });

  it('collects multiple fields', async () => {
    const { input: mockInput } = await import('@inquirer/prompts');
    (mockInput as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('Add dark mode')   // text field
      .mockResolvedValueOnce('Must work')        // array entry 1
      .mockResolvedValueOnce('');                // array stop

    const schema: InputSchema = {
      type: 'structured',
      fields: [
        { name: 'summary', type: 'text', prompt: 'Summary', required: true },
        { name: 'criteria', type: 'array', items: 'text', prompt: 'Criteria', required: true },
      ],
    };

    const result = await collectStructuredInput(schema);

    expect(result).toEqual({ summary: 'Add dark mode', criteria: ['Must work'] });
  });
});
```

Note: You'll need to add `InputSchema` to the imports at the top of the test file:
```typescript
import type { InputSchema } from '@studio-foundation/contracts';
```

**Step 2: Run to confirm failure**

```bash
pnpm --filter @studio-foundation/cli test
```

Expected: `collectStructuredInput` tests fail with "not implemented".

---

### Task 5: Implement `collectStructuredInput`

**Files:**
- Modify: `cli/src/utils/input-wizard.ts`

**Step 1: Replace the stub with the real implementation**

Replace the `collectStructuredInput` function body:

```typescript
export async function collectStructuredInput(
  schema: InputSchema
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};

  for (const field of schema.fields) {
    if (field.type === 'text') {
      result[field.name] = await input({
        message: field.prompt,
        required: field.required,
        default: field.default,
      });
    } else if (field.type === 'array') {
      const items: string[] = [];
      let index = 1;

      while (true) {
        const value = await input({
          message: `${field.prompt} (${index})`,
          required: index === 1 && field.required,
          default: '',
        });

        if (value === '') {
          if (index === 1 && field.required) {
            console.log('At least one value required.');
            continue;
          }
          break;
        }

        items.push(value);
        index++;
      }

      result[field.name] = items;
    }
  }

  console.log('\n✓ Input collected\n');
  return result;
}
```

**Step 2: Run all wizard tests**

```bash
pnpm --filter @studio-foundation/cli test
```

Expected: All `validateInputSchema` and `collectStructuredInput` tests pass.

**Step 3: Commit**

```bash
git add cli/src/utils/input-wizard.ts cli/tests/utils/input-wizard.test.ts
git commit -m "feat(cli): implement collectStructuredInput with test coverage"
```

---

### Task 6: Refactor `run.ts` — load pipeline early + wizard detection

**Files:**
- Modify: `cli/src/commands/run.ts`

This is the largest change. We restructure the input-resolution logic and load the pipeline unconditionally before input resolution.

**Step 1: Add imports at the top of `run.ts`**

After the existing imports, add:

```typescript
import type { PipelineDefinition } from '@studio-foundation/contracts';
import { validateInputSchema, collectStructuredInput } from '../utils/input-wizard.js';
```

**Step 2: Restructure `runCommand` — load pipeline early**

The current flow in `runCommand` (starting at line 186):
1. Resolve input → exit if none
2. Compute `configsDir`, `pipelinesDir`
3. Load pipeline (only inside `else` block for repo-URL resolution)

New flow:
1. Compute `configsDir`, `pipelinesDir` first
2. Load pipeline unconditionally
3. Resolve input (with wizard branch)
4. Resolve repo (reuses loaded pipeline)

Replace the body of `runCommand` from line 188 onwards with:

```typescript
export async function runCommand(pipelineName: string, options: RunOptions): Promise<void> {
  try {
    const config = await loadConfig(options.config);

    // Resolve configs dir and parse project/pipeline
    const configsDir = config.paths?.configs
      ? resolve(config.paths.configs)
      : config.resolvedStudioDir
        ? resolve(config.resolvedStudioDir, 'projects')
        : resolve('./configs');
    const { project, pipeline: pipelineBase } = parseProjectPipeline(pipelineName);
    const pipelinesDir = join(configsDir, project, 'pipelines');

    // Load pipeline early (needed for input_schema and repo URL)
    const pipelineDef = await loadPipelineByName(pipelineBase, pipelinesDir);

    // Resolve input: --input-file > --input > wizard > error
    let input: string | Record<string, unknown>;

    if (options.inputFile) {
      const inputPath = resolve(options.inputFile);
      let raw: string;
      try {
        raw = await readFile(inputPath, 'utf-8');
      } catch {
        console.error(`Error: Input file not found: ${inputPath}`);
        process.exit(1);
      }
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      } else {
        console.error('Error: Input file must contain a YAML object (key-value pairs)');
        process.exit(1);
      }
    } else if (options.input) {
      input = options.input;
    } else if (pipelineDef.input_schema?.type === 'structured') {
      try {
        const schema = validateInputSchema(pipelineDef.input_schema);
        input = await collectStructuredInput(schema);
      } catch (err) {
        console.error(`Error: Invalid input_schema in pipeline: ${(err as Error).message}`);
        process.exit(1);
      }
    } else {
      console.error('Error: --input or --input-file is required');
      process.exit(1);
    }

    // Resolve repo path: --repo > --repo-url > pipeline.repo.url > CWD
    let repoPath: string;

    if (options.repo) {
      repoPath = resolve(options.repo);
    } else {
      const repoUrl = options.repoUrl || pipelineDef.repo?.url;
      const effectiveBranch = pipelineDef.repo?.branch;

      if (repoUrl) {
        const projectsDir = config.paths?.projects_dir || process.env.STUDIO_PROJECTS_DIR;
        if (!projectsDir) {
          console.error('Error: STUDIO_PROJECTS_DIR is not set. Set it in .env or .studiorc.yaml paths.projects_dir');
          process.exit(1);
        }

        console.log(`Cloning ${repoUrl}...`);
        repoPath = await cloneRepo(repoUrl, projectsDir, pipelineName, effectiveBranch);
        console.log(`Cloned to: ${repoPath}\n`);
      } else {
        repoPath = '.';
      }
    }

    // ... rest of the function (provider registry, tools, engine) stays the same
```

The remainder of `runCommand` (provider registry setup, tool loading, progress display, engine execution) is unchanged.

**Step 3: Build**

```bash
pnpm build
```

Expected: Build succeeds. If there's a TypeScript error about `PipelineDefinition` already being imported transitively, remove the explicit import added in Step 1 (the type is re-exported from `@studio-foundation/engine`).

**Step 4: Smoke-test manually**

With a pipeline that has no `input_schema`, confirm the error message is unchanged:

```bash
# From project root — should error as before
node cli/dist/index.js run software/feature-builder 2>&1 | grep "Error:"
```

Expected: `Error: --input or --input-file is required`

**Step 5: Commit**

```bash
git add cli/src/commands/run.ts
git commit -m "feat(cli): load pipeline early in run command, add wizard detection"
```

---

### Task 7: Update the software template pipeline with `input_schema`

**Files:**
- Modify: `cli/templates/projects/software/project/pipelines/feature-builder.pipeline.yaml`

**Step 1: Add `input_schema` block**

Open the file. Its current content is:

```yaml
name: feature-builder
description: Analyze a request and generate code changes
version: 1

stages:
  - name: code-generation
    kind: code
    agent: coder
    ralph:
      max_attempts: 3
    context:
      include:
        - input
```

Replace with:

```yaml
name: feature-builder
description: Analyze a request and generate code changes
version: 1

input_schema:
  type: structured
  fields:
    - name: brief_summary
      type: text
      required: true
      prompt: "Brief summary"
    - name: target_page
      type: text
      required: false
      prompt: "Target page (optional)"
    - name: acceptance_criteria
      type: array
      items: text
      prompt: "Acceptance criteria"

stages:
  - name: code-generation
    kind: code
    agent: coder
    ralph:
      max_attempts: 3
    context:
      include:
        - input
```

**Step 2: Build**

```bash
pnpm build
```

Expected: Build succeeds.

**Step 3: Commit**

```bash
git add cli/templates/projects/software/project/pipelines/feature-builder.pipeline.yaml
git commit -m "feat(cli): add input_schema example to software template pipeline"
```

---

### Task 8: Final verification

**Step 1: Run all tests**

```bash
pnpm test
```

Expected: All tests pass. The new `input-wizard.test.ts` tests should all be green.

**Step 2: Run typecheck**

```bash
pnpm --filter @studio-foundation/cli typecheck
pnpm --filter @studio-foundation/contracts typecheck
```

Expected: No type errors.

**Step 3: Full build**

```bash
pnpm build
```

Expected: All 5 packages build successfully.

**Step 4: Final commit if anything was missed**

If there are any uncommitted changes:

```bash
git add -p
git commit -m "chore: final cleanup for STU-47"
```

**Step 5: Create PR**

```bash
git push -u origin arianedguay/stu-47-studio-run-input-wizard-phase-1
gh pr create \
  --title "feat(cli): STU-47 — studio run input wizard (Phase 1)" \
  --body "$(cat <<'EOF'
## What

Adds an interactive wizard to `studio run` that collects structured input when the pipeline declares an `input_schema`, eliminating the need to craft raw `--input` JSON or manually create `.input.yaml` files.

## Why

Users shouldn't need to know `.studio/` internals to run a pipeline. The wizard makes common use cases friction-free while preserving power-user bypass via `--input` and `--input-file`.

## Packages touched

- `contracts` — `InputField`, `InputSchema` types, `PipelineDefinition.input_schema`
- `cli` — new `src/utils/input-wizard.ts`, refactored `commands/run.ts`, updated software template

## How to test

```bash
# Run unit tests
pnpm test

# Manual test with wizard
studio init --template software
studio run software/feature-builder
# → should prompt for brief_summary, target_page, acceptance_criteria
```
EOF
)" \
  --base main
```
