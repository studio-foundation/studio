# STU-71: Template-Aware Init Command Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend `studio init --template <type> --name <project>` to generate a complete app (src/, prisma/, package.json, README.md, git repo) from the template, with placeholder replacement and template validation.

**Architecture:** Three new exported functions in `init.ts` (`generateAppFiles`, `initGitRepo`, `generateFullApp`) + a placeholder utility in `utils/placeholders.ts`. `initCommand` is updated to call `generateFullApp` when `--template` is provided. The software template gains app scaffold files and a 2nd pipeline so it passes `validateTemplateDir`.

**Tech Stack:** Node.js `fs/promises`, `child_process.spawnSync` (for git), existing `validateTemplateDir`, TypeScript, Vitest.

---

### Current state (read before touching anything)

- `cli/src/commands/init.ts` — `initCommand`, `directInit`, `createStudioStructure` already handle `.studio/` creation; they do NOT copy `src/`, `prisma/`, `package.json` or init git.
- `cli/templates/projects/software/` — has only `metadata.json` + `project/` (pipelines/agents/contracts/tools/inputs). No `src/`, `prisma/`, or `package.json`.
- `cli/src/commands/template/validate.ts` — `validateTemplateDir()` is already implemented (STU-70). It requires ≥2 `.pipeline.yaml` files. The current `software` template only has 1 → would fail validation.
- Tests in `cli/tests/commands/init.test.ts` use `/tmp/.studio-init-test` as base dir (per MEMORY.md).

---

### Task 1: Placeholder replacement utility

**Files:**
- Create: `cli/src/utils/placeholders.ts`
- Create: `cli/tests/utils/placeholders.test.ts`

**Step 1: Write the failing tests**

```typescript
// cli/tests/utils/placeholders.test.ts
import { describe, it, expect } from 'vitest';
import { applyPlaceholders } from '../../src/utils/placeholders.js';

describe('applyPlaceholders', () => {
  it('replaces a single known placeholder', () => {
    expect(applyPlaceholders('Hello {{PROJECT_NAME}}', { PROJECT_NAME: 'my-app' }))
      .toBe('Hello my-app');
  });

  it('replaces multiple placeholders in one pass', () => {
    const result = applyPlaceholders(
      'name: {{PROJECT_NAME}}\ntemplate: {{TEMPLATE_NAME}}\nyear: {{YEAR}}',
      { PROJECT_NAME: 'x', TEMPLATE_NAME: 'software', YEAR: '2026' }
    );
    expect(result).toBe('name: x\ntemplate: software\nyear: 2026');
  });

  it('replaces the same placeholder multiple times', () => {
    expect(applyPlaceholders('{{PROJECT_NAME}} / {{PROJECT_NAME}}', { PROJECT_NAME: 'app' }))
      .toBe('app / app');
  });

  it('throws on unresolved placeholder', () => {
    expect(() => applyPlaceholders('{{UNKNOWN}}', {}))
      .toThrow('Unresolved placeholder: {{UNKNOWN}}');
  });

  it('returns content unchanged when no placeholders', () => {
    expect(applyPlaceholders('no placeholders here', {})).toBe('no placeholders here');
  });

  it('does not replace lowercase or mixed-case patterns', () => {
    // Only {{ALL_CAPS_WITH_UNDERSCORES}} are treated as placeholders
    expect(applyPlaceholders('{{lowercase}}', {})).toBe('{{lowercase}}');
  });
});
```

**Step 2: Run to verify failure**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm --filter @studio-foundation/cli test 2>&1 | grep -A5 'placeholders'
```

Expected: fails with "Cannot find module" or similar.

**Step 3: Write the implementation**

```typescript
// cli/src/utils/placeholders.ts

/**
 * Replace {{ALL_CAPS}} placeholders in `content` with values from `vars`.
 * Throws if any placeholder has no corresponding entry in `vars`.
 */
export function applyPlaceholders(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (match, key) => {
    if (key in vars) return vars[key];
    throw new Error(`Unresolved placeholder: ${match}`);
  });
}
```

**Step 4: Run tests to verify pass**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm --filter @studio-foundation/cli test 2>&1 | grep -A5 'placeholders'
```

Expected: all 6 tests pass.

**Step 5: Commit**

```bash
git add cli/src/utils/placeholders.ts cli/tests/utils/placeholders.test.ts
git commit -m "feat(cli): add placeholder replacement utility (STU-71)"
```

---

### Task 2: Add app scaffold files to the `software` template

**Files:**
- Create: `cli/templates/projects/software/src/index.ts`
- Create: `cli/templates/projects/software/prisma/schema.prisma`
- Create: `cli/templates/projects/software/package.json`
- Create: `cli/templates/projects/software/README.md`
- Create: `cli/templates/projects/software/project/pipelines/quick-edit.pipeline.yaml`
- Create: `cli/templates/projects/software/project/contracts/quick-edit-output.contract.yaml`
- Modify: `cli/templates/projects/software/metadata.json` — add `quick-edit` to `pipelines` list

These are template files, not TypeScript. No tests here — they'll be exercised in Task 3.

**Step 1: Create `src/index.ts`**

```typescript
// cli/templates/projects/software/src/index.ts
// {{PROJECT_NAME}} — powered by Studio
// Run pipelines with: studio run {{TEMPLATE_NAME}}/feature-builder --input "..."
console.log('{{PROJECT_NAME}} ready.');
```

**Step 2: Create `prisma/schema.prisma`**

```prisma
// cli/templates/projects/software/prisma/schema.prisma
// {{PROJECT_NAME}} — Prisma schema
// Docs: https://pris.ly/d/prisma-schema

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

// Add your models below
```

**Step 3: Create `package.json`**

```json
{
  "name": "{{PROJECT_NAME}}",
  "version": "0.1.0",
  "description": "{{PROJECT_NAME}} — powered by Studio ({{TEMPLATE_NAME}} template)",
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc"
  },
  "dependencies": {},
  "devDependencies": {
    "typescript": "^5.3.0",
    "@types/node": "^20.0.0",
    "tsx": "^4.0.0"
  }
}
```

**Step 4: Create `README.md`**

```markdown
# {{PROJECT_NAME}}

Generated from the [`{{TEMPLATE_NAME}}`](https://studio.dev/templates/{{TEMPLATE_NAME}}) Studio template.

## Getting started

```bash
npm install
studio run {{TEMPLATE_NAME}}/feature-builder --input "Your task description"
```

## Pipelines

- **feature-builder** — Analyze a request and generate code changes
- **quick-edit** — Apply a focused single-file edit

## Configuration

Set your API key:

```bash
studio config set provider anthropic --api-key $ANTHROPIC_API_KEY
```

## Learn more

- [Studio docs](https://studio.dev/docs)
- [Template reference](https://studio.dev/templates/{{TEMPLATE_NAME}})
```

**Step 5: Create `project/pipelines/quick-edit.pipeline.yaml`**

```yaml
name: quick-edit
description: Apply a focused single-file code edit
version: 1

input_schema:
  type: structured
  fields:
    - name: instruction
      type: text
      required: true
      prompt: "What to change"
    - name: target_file
      type: text
      required: true
      prompt: "File to edit"

stages:
  - name: edit
    kind: code
    agent: coder
    ralph:
      max_attempts: 2
    context:
      include:
        - input
```

**Step 6: Create `project/contracts/quick-edit-output.contract.yaml`**

```yaml
name: quick-edit-output
version: 1
schema:
  required_fields:
    - summary
    - file_changed
tool_calls:
  minimum: 1
```

**Step 7: Update `metadata.json` to include the new pipeline**

Replace the `pipelines` field:
```json
"pipelines": ["feature-builder", "quick-edit"]
```

The full updated `metadata.json`:
```json
{
  "name": "software",
  "version": "1.0.0",
  "description": "Code generation with repo, shell and search tools",
  "author": "studio-core",
  "tags": ["software", "code", "development"],
  "type": "template",
  "studio_version": ">=7.0.0",
  "pipelines": ["feature-builder", "quick-edit"],
  "tools_included": ["repo-manager", "search", "shell"]
}
```

**Step 8: Verify validate passes**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm build
node cli/dist/index.js template validate cli/templates/projects/software
```

Expected output:
```
✓ Structural validation passed
✓ Semantic validation passed
```

If semantic validation fails because `quick-edit` pipeline references contract `quick-edit-output` but that contract doesn't exist in the right place — check the stage's `contract:` field. The pipeline above does NOT reference a contract (contract field is omitted), so there's nothing to cross-reference. If validate requires contracts per pipeline, add `contract: quick-edit-output` to the stage and ensure the contract file exists (we just created it).

**Step 9: Commit**

```bash
git add cli/templates/projects/software/
git commit -m "feat(templates): add app scaffold files and second pipeline to software template (STU-71)"
```

---

### Task 3: `generateAppFiles()` function

**Files:**
- Modify: `cli/src/commands/init.ts` — add `generateAppFiles` export
- Modify: `cli/tests/commands/init.test.ts` — add `describe('generateAppFiles')` block

**Step 1: Write the failing tests**

Append to `cli/tests/commands/init.test.ts`:

```typescript
describe('generateAppFiles', () => {
  // Reuses existing TMP + beforeEach/afterEach from top of file

  it('copies src/ directory with placeholder replacement', async () => {
    const { generateAppFiles } = await import('../../src/commands/init.js');

    // Use the real software template
    const templateDir = new URL(
      '../../../templates/projects/software',
      import.meta.url
    ).pathname;

    await generateAppFiles(templateDir, TMP, {
      PROJECT_NAME: 'my-app',
      TEMPLATE_NAME: 'software',
      YEAR: '2026',
    });

    const srcIndex = await readFile(resolve(TMP, 'src', 'index.ts'), 'utf-8');
    expect(srcIndex).toContain('my-app');
    expect(srcIndex).not.toContain('{{PROJECT_NAME}}');
  });

  it('copies package.json with placeholder replacement', async () => {
    const { generateAppFiles } = await import('../../src/commands/init.js');

    const templateDir = new URL(
      '../../../templates/projects/software',
      import.meta.url
    ).pathname;

    await generateAppFiles(templateDir, TMP, {
      PROJECT_NAME: 'cool-project',
      TEMPLATE_NAME: 'software',
      YEAR: '2026',
    });

    const pkg = JSON.parse(await readFile(resolve(TMP, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('cool-project');
  });

  it('copies README.md with placeholder replacement', async () => {
    const { generateAppFiles } = await import('../../src/commands/init.js');

    const templateDir = new URL(
      '../../../templates/projects/software',
      import.meta.url
    ).pathname;

    await generateAppFiles(templateDir, TMP, {
      PROJECT_NAME: 'my-app',
      TEMPLATE_NAME: 'software',
      YEAR: '2026',
    });

    const readme = await readFile(resolve(TMP, 'README.md'), 'utf-8');
    expect(readme).toContain('my-app');
    expect(readme).toContain('software');
    expect(readme).not.toContain('{{PROJECT_NAME}}');
  });

  it('copies prisma/schema.prisma', async () => {
    const { generateAppFiles } = await import('../../src/commands/init.js');

    const templateDir = new URL(
      '../../../templates/projects/software',
      import.meta.url
    ).pathname;

    await generateAppFiles(templateDir, TMP, {
      PROJECT_NAME: 'my-app',
      TEMPLATE_NAME: 'software',
      YEAR: '2026',
    });

    expect(await exists(resolve(TMP, 'prisma', 'schema.prisma'))).toBe(true);
  });

  it('skips items not present in template (e.g. no src/ in blank template)', async () => {
    const { generateAppFiles } = await import('../../src/commands/init.js');

    const templateDir = new URL(
      '../../../templates/projects/blank',
      import.meta.url
    ).pathname;

    // Should not throw even though blank template has no src/ or package.json
    await expect(
      generateAppFiles(templateDir, TMP, {
        PROJECT_NAME: 'x',
        TEMPLATE_NAME: 'blank',
        YEAR: '2026',
      })
    ).resolves.not.toThrow();
  });

  it('returns list of generated file paths', async () => {
    const { generateAppFiles } = await import('../../src/commands/init.js');

    const templateDir = new URL(
      '../../../templates/projects/software',
      import.meta.url
    ).pathname;

    const generated = await generateAppFiles(templateDir, TMP, {
      PROJECT_NAME: 'my-app',
      TEMPLATE_NAME: 'software',
      YEAR: '2026',
    });

    expect(generated).toContain('package.json');
    expect(generated).toContain('README.md');
  });
});
```

**Step 2: Run to verify failure**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm build && pnpm --filter @studio-foundation/cli test 2>&1 | grep -A3 'generateAppFiles'
```

Expected: fails with "generateAppFiles is not a function" or export not found.

**Step 3: Implement `generateAppFiles` in `cli/src/commands/init.ts`**

Add these imports at the top of `init.ts` (if not already present):

```typescript
import { readdir, lstat, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { applyPlaceholders } from '../utils/placeholders.js';
```

Add the constant and function:

```typescript
// App scaffold items to copy from template root → target root
const APP_SCAFFOLD_ITEMS = ['src', 'prisma', 'package.json', 'README.md'];

/**
 * Copy app scaffold files (src/, prisma/, package.json, README.md) from
 * `templateDir` to `targetDir`, applying placeholder replacement to all
 * text file contents. Items missing from the template are silently skipped.
 *
 * @returns List of top-level items that were generated (e.g. ['src/', 'package.json'])
 */
export async function generateAppFiles(
  templateDir: string,
  targetDir: string,
  vars: Record<string, string>
): Promise<string[]> {
  const generated: string[] = [];

  for (const item of APP_SCAFFOLD_ITEMS) {
    const src = join(templateDir, item);
    const dest = join(targetDir, item);

    let stat;
    try {
      stat = await lstat(src);
    } catch {
      continue; // Not present in this template — skip
    }

    if (stat.isDirectory()) {
      await copyDirWithPlaceholders(src, dest, vars);
      generated.push(item + '/');
    } else {
      const content = await readFile(src, 'utf-8');
      const replaced = applyPlaceholders(content, vars);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, replaced, 'utf-8');
      generated.push(item);
    }
  }

  return generated;
}

/**
 * Recursively copy a directory, applying placeholder replacement to all file contents.
 */
async function copyDirWithPlaceholders(
  src: string,
  dest: string,
  vars: Record<string, string>
): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirWithPlaceholders(srcPath, destPath, vars);
    } else {
      // Try text replacement; fall back to raw copy for binary files
      try {
        const content = await readFile(srcPath, 'utf-8');
        const replaced = applyPlaceholders(content, vars);
        await writeFile(destPath, replaced, 'utf-8');
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Unresolved placeholder')) {
          throw err;
        }
        // Binary file — copy as-is
        await copyFile(srcPath, destPath);
      }
    }
  }
}
```

**Step 4: Build and run tests**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm build && pnpm --filter @studio-foundation/cli test 2>&1 | grep -E '(generateAppFiles|PASS|FAIL|✓|✗)'
```

Expected: all `generateAppFiles` tests pass, existing tests still pass.

**Step 5: Commit**

```bash
git add cli/src/commands/init.ts cli/tests/commands/init.test.ts
git commit -m "feat(cli): add generateAppFiles for full-app template scaffolding (STU-71)"
```

---

### Task 4: `initGitRepo()` function

**Files:**
- Modify: `cli/src/commands/init.ts` — add `initGitRepo` export
- Modify: `cli/tests/commands/init.test.ts` — add `describe('initGitRepo')` block

**Step 1: Write the failing tests**

Append to `cli/tests/commands/init.test.ts`:

```typescript
describe('initGitRepo', () => {
  it('creates a .git/ directory in cwd', async () => {
    const { initGitRepo } = await import('../../src/commands/init.js');
    const gitDir = resolve(TMP, '.git');

    await initGitRepo(TMP);

    expect(await exists(gitDir)).toBe(true);
  });

  it('returns true when it initializes git', async () => {
    const { initGitRepo } = await import('../../src/commands/init.js');
    const result = await initGitRepo(TMP);
    expect(result).toBe(true);
  });

  it('returns false (skips) when .git/ already exists', async () => {
    const { initGitRepo } = await import('../../src/commands/init.js');
    await initGitRepo(TMP); // first init
    const result = await initGitRepo(TMP); // should skip
    expect(result).toBe(false);
  });
});
```

**Step 2: Run to verify failure**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm build && pnpm --filter @studio-foundation/cli test 2>&1 | grep -A3 'initGitRepo'
```

Expected: fails with export not found.

**Step 3: Implement `initGitRepo` in `cli/src/commands/init.ts`**

Add this import at the top (if not already present):
```typescript
import { spawnSync } from 'node:child_process';
```

Add the function:

```typescript
/**
 * Run `git init` in `cwd` unless a `.git/` directory already exists.
 * Returns true if git was initialized, false if it was skipped.
 * Throws if `git init` exits with non-zero status.
 */
export async function initGitRepo(cwd: string): Promise<boolean> {
  const gitDir = join(cwd, '.git');
  const alreadyGit = await access(gitDir).then(() => true).catch(() => false);
  if (alreadyGit) return false;

  const result = spawnSync('git', ['init'], { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    throw new Error(`git init failed: ${stderr}`);
  }
  return true;
}
```

**Step 4: Build and run tests**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm build && pnpm --filter @studio-foundation/cli test 2>&1 | grep -E '(initGitRepo|PASS|FAIL|✓|✗)'
```

Expected: all `initGitRepo` tests pass.

**Step 5: Commit**

```bash
git add cli/src/commands/init.ts cli/tests/commands/init.test.ts
git commit -m "feat(cli): add initGitRepo helper (STU-71)"
```

---

### Task 5: `generateFullApp()` — the top-level orchestrator

This function ties everything together: validate template → create .studio/ → copy app files → git init.

**Files:**
- Modify: `cli/src/commands/init.ts` — add `generateFullApp` export
- Modify: `cli/tests/commands/init.test.ts` — add `describe('generateFullApp')` block

**Step 1: Write the failing tests**

Append to `cli/tests/commands/init.test.ts`:

```typescript
describe('generateFullApp', () => {
  it('creates .studio/ structure AND src/ AND package.json AND README.md', async () => {
    const { generateFullApp } = await import('../../src/commands/init.js');

    await generateFullApp(TMP, 'my-app', 'software');

    // .studio/ structure
    expect(await exists(resolve(TMP, '.studio', 'projects', 'my-app', 'pipelines'))).toBe(true);
    // App scaffold
    expect(await exists(resolve(TMP, 'src', 'index.ts'))).toBe(true);
    expect(await exists(resolve(TMP, 'package.json'))).toBe(true);
    expect(await exists(resolve(TMP, 'README.md'))).toBe(true);
    expect(await exists(resolve(TMP, 'prisma', 'schema.prisma'))).toBe(true);
  });

  it('applies PROJECT_NAME placeholder in package.json', async () => {
    const { generateFullApp } = await import('../../src/commands/init.js');

    await generateFullApp(TMP, 'cool-app', 'software');

    const pkg = JSON.parse(await readFile(resolve(TMP, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('cool-app');
  });

  it('initializes a git repository', async () => {
    const { generateFullApp } = await import('../../src/commands/init.js');

    await generateFullApp(TMP, 'my-app', 'software');

    expect(await exists(resolve(TMP, '.git'))).toBe(true);
  });

  it('throws when template does not exist', async () => {
    const { generateFullApp } = await import('../../src/commands/init.js');

    await expect(
      generateFullApp(TMP, 'my-app', 'nonexistent-template')
    ).rejects.toThrow();
  });

  it('throws when template fails validation (bad template)', async () => {
    const { generateFullApp } = await import('../../src/commands/init.js');

    // Create a fake broken template dir (no project/ subdirectory)
    const badTemplate = resolve(TMP, 'bad-template');
    await mkdir(badTemplate, { recursive: true });
    await writeFile(resolve(badTemplate, 'metadata.json'), JSON.stringify({
      name: 'bad', version: '1.0.0', description: 'broken'
    }));

    // We need to point generateFullApp at this fake template.
    // This test documents the behavior; the implementation detail
    // (how to pass a custom templateDir) may require a test-only option.
    // See implementation notes below.
    await expect(
      generateFullApp(TMP, 'my-app', 'bad', { _templatesDirOverride: badTemplate })
    ).rejects.toThrow('validation');
  });

  it('skips git init when skipGit option is true', async () => {
    const { generateFullApp } = await import('../../src/commands/init.js');

    await generateFullApp(TMP, 'my-app', 'software', { skipGit: true });

    expect(await exists(resolve(TMP, '.git'))).toBe(false);
    // But .studio/ should still exist
    expect(await exists(resolve(TMP, '.studio'))).toBe(true);
  });
});
```

**Step 2: Run to verify failure**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm build && pnpm --filter @studio-foundation/cli test 2>&1 | grep -A3 'generateFullApp'
```

**Step 3: Implement `generateFullApp` in `cli/src/commands/init.ts`**

Add this import at the top:
```typescript
import { validateTemplateDir } from './template/validate.js';
```

Add the function:

```typescript
interface GenerateFullAppOptions {
  noTools?: boolean;
  skipGit?: boolean;
  /** Internal: override templates root dir (for testing broken templates) */
  _templatesDirOverride?: string;
}

/**
 * Generate a complete app from a template:
 * 1. Validates the template structure
 * 2. Creates .studio/ workspace
 * 3. Copies app scaffold files (src/, prisma/, package.json, README.md)
 * 4. Initializes a git repository (unless skipGit)
 *
 * Does NOT write provider config — call writeProviderToConfig separately.
 */
export async function generateFullApp(
  cwd: string,
  projectName: string,
  templateName: string,
  options: GenerateFullAppOptions = {}
): Promise<void> {
  const templatesRoot = options._templatesDirOverride
    ? options._templatesDirOverride
    : resolve(TEMPLATES_DIR, 'projects', templateName);

  // 1. Validate template
  const validation = await validateTemplateDir(
    options._templatesDirOverride ?? templatesRoot
  );
  if (!validation.valid) {
    const allErrors = [...validation.structuralErrors, ...validation.semanticErrors];
    throw new Error(
      `Template '${templateName}' failed validation:\n` +
      allErrors.map((e) => `  • ${e}`).join('\n')
    );
  }

  // 2. Create .studio/ workspace
  await createStudioStructure(cwd, projectName, templateName, !options.noTools);

  // 3. Copy app scaffold files with placeholder replacement
  const vars = {
    PROJECT_NAME: projectName,
    TEMPLATE_NAME: templateName,
    YEAR: String(new Date().getFullYear()),
  };
  await generateAppFiles(templatesRoot, cwd, vars);

  // 4. Initialize git repo
  if (!options.skipGit) {
    await initGitRepo(cwd);
  }
}
```

**Note on the `_templatesDirOverride` test:**
The "throws when template fails validation" test passes a `badTemplate` directory path directly. The `generateFullApp` function uses `options._templatesDirOverride` as the full path to the template directory (bypassing the normal `TEMPLATES_DIR/projects/<name>` lookup). This works because `validateTemplateDir` takes a path directly.

**Step 4: Build and run all tests**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm build && pnpm --filter @studio-foundation/cli test
```

Expected: all tests pass, including existing tests for `createStudioStructure`, `directInit`, etc.

If a test fails because the software template is being validated (requires 2 pipelines) and the 2nd pipeline added in Task 2 has a semantic issue (e.g., missing contract reference), fix the `quick-edit.pipeline.yaml` to not reference a contract, or ensure `quick-edit-output.contract.yaml` is in the right place.

**Step 5: Commit**

```bash
git add cli/src/commands/init.ts cli/tests/commands/init.test.ts
git commit -m "feat(cli): add generateFullApp orchestrator (STU-71)"
```

---

### Task 6: Wire `generateFullApp` into `initCommand`

Update `initCommand` to call `generateFullApp` (instead of `directInit`) when `--template` is provided. Update success output to list new files. Update "next steps" to include `npm install`.

**Files:**
- Modify: `cli/src/commands/init.ts` — `initCommand` function

**Step 1: Update direct mode in `initCommand`**

Current direct mode detection:
```typescript
const isDirectMode = !!(options.template && options.provider);
```

This stays the same — direct mode requires both `--template` and `--provider`. But now inside direct mode, replace `directInit` with `generateFullApp` + `writeProviderToConfig`.

Find this block in `initCommand`:

```typescript
if (isDirectMode) {
  // ...
  const spinner = ora('Creating project...').start();
  try {
    await directInit(cwd, projectName, options.template!, options.provider!, options.apiKey ?? '', options.tools === false);
    spinner.stop();
  } catch (err) {
    spinner.fail('Failed');
    throw err;
  }

  console.log(chalk.green(`  ✓ .studio/config.yaml`));
  console.log(chalk.green(`  ✓ .studio/projects/${projectName}/`));
  console.log(chalk.green(`  ✓ Applied template: ${options.template}`));
  console.log(chalk.green(`  ✓ Updated .gitignore`));
  // ...
```

Replace with:

```typescript
if (isDirectMode) {
  // ... (keep existing API key validation logic unchanged) ...

  const projectName = nameArg ?? options.project ?? basename(cwd);
  const spinner = ora('Creating project...').start();

  try {
    await generateFullApp(cwd, projectName, options.template!, {
      noTools: options.tools === false,
    });
    if (options.provider !== 'later' && options.apiKey) {
      const studioDir = resolve(cwd, '.studio');
      await writeProviderToConfig(studioDir, options.provider!, options.apiKey);
    }
    spinner.stop();
  } catch (err) {
    spinner.fail('Failed');
    throw err;
  }

  console.log(chalk.green(`  ✓ .studio/projects/${projectName}/`));
  console.log(chalk.green(`  ✓ src/`));
  console.log(chalk.green(`  ✓ prisma/schema.prisma`));
  console.log(chalk.green(`  ✓ package.json`));
  console.log(chalk.green(`  ✓ README.md`));
  console.log(chalk.green(`  ✓ .studio/config.yaml`));
  console.log(chalk.green(`  ✓ git initialized`));
  console.log(chalk.green(`  ✓ Updated .gitignore`));
  console.log('');

  const templates = await listTemplates();
  const selectedTemplate = templates.find((t) => t.name === options.template);
  const firstPipeline = selectedTemplate?.pipelines?.[0] ?? 'your-pipeline';

  console.log(chalk.bold('Done! Next steps:'));
  console.log(`  ${chalk.cyan('npm install')}`);
  console.log(`  ${chalk.cyan(`studio run ${projectName}/${firstPipeline} --input "..."`)}`);
  if (options.provider === 'later') {
    console.log('');
    console.log('Set your API key first:');
    console.log(
      `  ${chalk.cyan('studio config set provider anthropic --api-key $ANTHROPIC_API_KEY')}`
    );
  }
  console.log('');
  return;
}
```

**Step 2: Update wizard mode to also call `generateFullApp`**

In wizard mode, find the block starting at "Step 7: Create structure":

```typescript
// Step 7: Create structure (without tools — we install them below)
const spinner = ora('Creating project...').start();
const studioDir = resolve(cwd, '.studio');
try {
  await createStudioStructure(cwd, projectName, templateName, false);
  if (provider !== 'later' && apiKey) {
    await writeProviderToConfig(studioDir, provider, apiKey, selectedModel);
  }
  spinner.stop();
} catch (err) {
  spinner.fail('Failed');
  throw err;
}
```

Replace `createStudioStructure` call with `generateFullApp`:

```typescript
// Step 7: Create structure (without tools — we install them below)
const spinner = ora('Creating project...').start();
const studioDir = resolve(cwd, '.studio');
try {
  await generateFullApp(cwd, projectName, templateName, { noTools: true });
  if (provider !== 'later' && apiKey) {
    await writeProviderToConfig(studioDir, provider, apiKey, selectedModel);
  }
  spinner.stop();
} catch (err) {
  spinner.fail('Failed');
  throw err;
}
```

And update the success output in wizard mode to add the new files and `npm install` step:

After "Step 9: Success output", update:
```typescript
console.log(chalk.green(`  ✓ .studio/projects/${projectName}/`));
console.log(chalk.green(`  ✓ src/`));
console.log(chalk.green(`  ✓ prisma/schema.prisma`));
console.log(chalk.green(`  ✓ package.json`));
console.log(chalk.green(`  ✓ README.md`));
console.log(chalk.green(`  ✓ .studio/config.yaml`));
console.log(chalk.green(`  ✓ git initialized`));
console.log(chalk.green(`  ✓ Updated .gitignore`));
if (selectedTools.length > 0) {
  console.log(chalk.green(`  ✓ Installed tools: ${selectedTools.join(', ')}`));
}
```

And "Step 10: Next steps":
```typescript
console.log(chalk.bold('Done! Next steps:'));
console.log(`  ${chalk.cyan('npm install')}`);
console.log(
  `  ${chalk.cyan(`studio run ${projectName}/${firstPipeline} --input "..."`)}`
);
```

**Step 3: Build and run all tests**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm build && pnpm test
```

Expected: all tests pass. If `directInit` tests in the existing test suite fail because they no longer test the current `directInit` path... `directInit` is still exported and unchanged. The tests import `directInit` directly and call it — they don't go through `initCommand`. So they should still pass.

**Step 4: Smoke-test manually**

```bash
cd /tmp
mkdir test-stu71 && cd test-stu71
node /home/arianeguay/dev/src/Studio/cli/dist/index.js init \
  --template software \
  --project my-app \
  --provider later \
  --yes

ls -la
# Expected: .studio/ src/ prisma/ package.json README.md .git/ .gitignore
cat package.json
# Expected: "name": "my-app"
cat README.md
# Expected: # my-app ... software
ls .git/
# Expected: git init output

# Cleanup
cd /tmp && rm -rf test-stu71
```

**Step 5: Commit**

```bash
git add cli/src/commands/init.ts
git commit -m "feat(cli): wire generateFullApp into initCommand (STU-71)"
```

---

### Task 7: Final verification + cleanup

**Step 1: Run full test suite**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm test
```

Expected: all tests across all packages pass. Zero failures.

**Step 2: Build check**

```bash
pnpm build
```

Expected: exits 0.

**Step 3: Verify acceptance criteria**

Manually check each item from STU-71:

- [ ] `studio init --template software --name my-app` works → test above
- [ ] Copies entire template directory → `src/`, `prisma/`, `package.json`, `README.md` present
- [ ] Replaces placeholders → `package.json` has `"name": "my-app"`, no `{{...}}`
- [ ] Initializes git repository → `.git/` exists
- [ ] Creates `.studio/config.yaml` with providers → pass `--provider anthropic --api-key sk-ant-...` to test
- [ ] Generates contextual `README.md` → present with correct project name
- [ ] Works with all template types → only `software` has full scaffold; others silently skip missing files
- [ ] Shows success message with next steps including `npm install`
- [ ] Validates template before copying → `generateFullApp` calls `validateTemplateDir`

**Step 4: Mark STU-71 as Done in Linear**

Use the Linear MCP tool to update issue `STU-71` status to Done.

---

### Notes for executor

- **Imports to add in init.ts:** `readdir`, `lstat`, `copyFile` from `node:fs/promises`; `spawnSync` from `node:child_process`; `applyPlaceholders` from `../utils/placeholders.js`; `validateTemplateDir` from `./template/validate.js`. Check existing imports first — some may already be there.
- **`TEMPLATES_DIR` constant** is already defined in `init.ts` as `resolve(import.meta.dirname, '../../templates')`. The template project dirs are at `join(TEMPLATES_DIR, 'projects', templateName)`.
- **`_templatesDirOverride`** in `generateFullApp` options is an escape hatch for testing with bad templates. The `validateTemplateDir` call should use `options._templatesDirOverride ?? join(TEMPLATES_DIR, 'projects', templateName)` to accept either the override path OR the normal constructed path.
- **Don't break existing tests.** `directInit` remains exported and unchanged. `createStudioStructure` remains unchanged. Only new code is added, plus `initCommand` is updated.
- **Software template pipelines list in metadata.json** must match the actual pipeline filenames. After adding `quick-edit.pipeline.yaml`, update `"pipelines": ["feature-builder", "quick-edit"]`.
