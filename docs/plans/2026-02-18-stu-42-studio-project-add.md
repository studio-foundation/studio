# STU-42: `studio project add` wizard — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `studio project add` to create a new project inside an existing Studio workspace (`.studio/`), with both wizard and direct modes.

**Architecture:** Extract `createProjectDir` from `init.ts` into a new `project.ts`. `init.ts` imports `createProjectDir` from `project.ts`. `project.ts` also defines `validateProjectName`, `projectAddDirect`, `projectAddWizard`, and `projectCommand`. Registered in `index.ts` as `project <action> [args...]`.

**Tech Stack:** TypeScript, `@inquirer/prompts` (input, select), chalk, ora, Commander.js, `node:fs/promises`, vitest

---

## Context

`createStudioStructure` in `cli/src/commands/init.ts` creates the full workspace AND the first project dir. Its project-dir creation logic (lines 38–66) is:

```typescript
if (templateName) {
  const templateDir = resolve(TEMPLATES_DIR, 'projects', templateName);
  const templateExists = await access(templateDir).then(() => true).catch(() => false);
  if (!templateExists) {
    throw new Error(`Template '${templateName}' not found. Run 'studio templates list' ...`);
  }
  const templateProjectDir = join(templateDir, 'project');
  const hasProjectDir = await access(templateProjectDir).then(() => true).catch(() => false);
  if (hasProjectDir) {
    await mkdir(projectDir, { recursive: true });
    await cp(templateProjectDir, projectDir, { recursive: true });
  } else {
    for (const sub of PROJECT_SUBDIRS) {
      await mkdir(join(projectDir, sub), { recursive: true });
    }
  }
} else {
  for (const sub of PROJECT_SUBDIRS) {
    await mkdir(join(projectDir, sub), { recursive: true });
  }
}
```

This logic moves verbatim into `createProjectDir` in `project.ts`. `createStudioStructure` then calls `createProjectDir`.

The test base directory MUST be `/tmp/...` (never a subdirectory of the Studio repo). See MEMORY.md.

---

## Task 1: Create `project.ts` with `createProjectDir` (TDD)

**Files:**
- Create: `cli/src/commands/project.ts`
- Create: `cli/tests/commands/project.test.ts`

### Step 1: Write the failing tests

Create `cli/tests/commands/project.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, access, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// IMPORTANT: must be under /tmp, not a Studio repo subdirectory
const TMP = resolve('/tmp', '.studio-project-test');
const PROJECTS_DIR = join(TMP, '.studio', 'projects');

beforeEach(async () => { await mkdir(PROJECTS_DIR, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe('createProjectDir', () => {
  it('creates 5 empty subdirs when no template given', async () => {
    const { createProjectDir } = await import('../../src/commands/project.js');
    await createProjectDir(PROJECTS_DIR, 'my-app');

    const projectDir = join(PROJECTS_DIR, 'my-app');
    for (const sub of ['pipelines', 'agents', 'contracts', 'tools', 'inputs']) {
      expect(await exists(join(projectDir, sub))).toBe(true);
    }
  });

  it('creates 5 empty subdirs for blank template (no project/ subdir in template)', async () => {
    const { createProjectDir } = await import('../../src/commands/project.js');
    await createProjectDir(PROJECTS_DIR, 'my-app', 'blank');

    const pipelinesDir = join(PROJECTS_DIR, 'my-app', 'pipelines');
    expect(await exists(pipelinesDir)).toBe(true);
    const entries = await readdir(pipelinesDir);
    expect(entries).toEqual([]);
  });

  it('copies software template files into the project dir', async () => {
    const { createProjectDir } = await import('../../src/commands/project.js');
    await createProjectDir(PROJECTS_DIR, 'my-app', 'software');

    expect(await exists(join(PROJECTS_DIR, 'my-app', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);
    expect(await exists(join(PROJECTS_DIR, 'my-app', 'agents', 'coder.agent.yaml'))).toBe(true);
    expect(await exists(join(PROJECTS_DIR, 'my-app', 'contracts', 'code-output.contract.yaml'))).toBe(true);
    expect(await exists(join(PROJECTS_DIR, 'my-app', 'tools', 'repo-manager.tool.yaml'))).toBe(true);
    expect(await exists(join(PROJECTS_DIR, 'my-app', 'inputs', 'example.input.yaml'))).toBe(true);
  });

  it('throws "already exists" when the project dir already exists', async () => {
    const { createProjectDir } = await import('../../src/commands/project.js');
    await createProjectDir(PROJECTS_DIR, 'my-app');
    await expect(createProjectDir(PROJECTS_DIR, 'my-app')).rejects.toThrow("Project 'my-app' already exists");
  });

  it('throws "not found" with template list hint for invalid template', async () => {
    const { createProjectDir } = await import('../../src/commands/project.js');
    const err = await createProjectDir(PROJECTS_DIR, 'my-app', 'nonexistent').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Template 'nonexistent' not found");
    expect((err as Error).message).toContain('studio templates list');
  });
});
```

### Step 2: Run tests to verify they fail

```bash
cd /home/arianeguay/dev/src/Studio
pnpm --filter @studio/cli test
```

Expected: 5 failures — `createProjectDir is not a function` (or module not found).

### Step 3: Implement `createProjectDir` in `project.ts`

Create `cli/src/commands/project.ts`:

```typescript
import { mkdir, access, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const TEMPLATES_DIR = resolve(import.meta.dirname, '../../templates');

export const PROJECT_SUBDIRS = ['pipelines', 'agents', 'contracts', 'tools', 'inputs'];

/**
 * Create a project directory under .studio/projects/.
 * Throws if the project already exists or the template is not found.
 */
export async function createProjectDir(
  projectsDir: string,
  projectName: string,
  templateName?: string
): Promise<void> {
  const projectDir = join(projectsDir, projectName);

  // Check if already exists
  const alreadyExists = await access(projectDir).then(() => true).catch(() => false);
  if (alreadyExists) {
    throw new Error(`Project '${projectName}' already exists in ${projectsDir}`);
  }

  if (templateName) {
    const templateDir = resolve(TEMPLATES_DIR, 'projects', templateName);
    const templateExists = await access(templateDir).then(() => true).catch(() => false);
    if (!templateExists) {
      throw new Error(
        `Template '${templateName}' not found. Run 'studio templates list' to see available templates.`
      );
    }

    const templateProjectDir = join(templateDir, 'project');
    const hasProjectDir = await access(templateProjectDir).then(() => true).catch(() => false);

    if (hasProjectDir) {
      await mkdir(projectDir, { recursive: true });
      await cp(templateProjectDir, projectDir, { recursive: true });
    } else {
      for (const sub of PROJECT_SUBDIRS) {
        await mkdir(join(projectDir, sub), { recursive: true });
      }
    }
  } else {
    for (const sub of PROJECT_SUBDIRS) {
      await mkdir(join(projectDir, sub), { recursive: true });
    }
  }
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter @studio/cli test
```

Expected: 5 new tests PASS, all existing tests still PASS.

### Step 5: Commit

```bash
git add cli/src/commands/project.ts cli/tests/commands/project.test.ts
git commit -m "feat(cli): STU-42 — createProjectDir in project.ts (TDD)"
```

---

## Task 2: Refactor `init.ts` to use `createProjectDir`

**Files:**
- Modify: `cli/src/commands/init.ts`

`createStudioStructure` currently embeds the project-dir creation logic inline. Replace it with a call to `createProjectDir`.

### Step 1: Update imports in `init.ts`

At the top of `cli/src/commands/init.ts`, add the import:

```typescript
import { createProjectDir } from './project.js';
```

Remove the `TEMPLATES_DIR` constant (it now lives in `project.ts`).

Remove the `PROJECT_SUBDIRS` constant (it now lives in `project.ts`).

### Step 2: Simplify `createStudioStructure`

Replace the block from line 35 to line 66 (everything between the `const studioDir` and `// Create runs/logs/` comment) with:

```typescript
  const studioDir = resolve(cwd, '.studio');
  const projectsDir = join(studioDir, 'projects');
  await mkdir(projectsDir, { recursive: true });
  await createProjectDir(projectsDir, projectName, templateName);
```

The full updated function body should be:

```typescript
export async function createStudioStructure(
  cwd: string,
  projectName = 'default',
  templateName?: string
): Promise<void> {
  // Check if already initialized
  const existing = await findStudioDir(cwd);
  if (existing) {
    throw new Error(
      `Studio is already initialized at ${existing}\n` +
        `If you want to reinitialize, delete the .studio/ directory first.`
    );
  }

  const studioDir = resolve(cwd, '.studio');
  const projectsDir = join(studioDir, 'projects');
  await mkdir(projectsDir, { recursive: true });
  await createProjectDir(projectsDir, projectName, templateName);

  // Create runs/logs/
  await mkdir(join(studioDir, 'runs', 'logs'), { recursive: true });

  // Write registry.lock.json (empty, committed)
  await writeFile(join(studioDir, 'registry.lock.json'), '{}\n', 'utf-8');

  // Copy config template (only if config.yaml doesn't already exist)
  const configPath = join(studioDir, 'config.yaml');
  const configExists = await access(configPath)
    .then(() => true)
    .catch(() => false);
  if (!configExists) {
    const template = await readFile(resolve(TEMPLATES_DIR_CONFIG, 'studio-config.yaml'), 'utf-8');
    await writeFile(configPath, template, 'utf-8');
  }

  // Update .gitignore
  await updateGitignore(cwd);
}
```

Wait — `init.ts` still needs `TEMPLATES_DIR` for `studio-config.yaml`. Rename the remaining constant to `TEMPLATES_DIR_CONFIG` (or keep it as `TEMPLATES_DIR` for the config template only). Since only `studio-config.yaml` is used from this constant in `init.ts`, keep the constant but rename it for clarity:

```typescript
const TEMPLATES_DIR = resolve(import.meta.dirname, '../../templates');
```

Keep this line as-is in `init.ts` — it's still needed for `readFile(resolve(TEMPLATES_DIR, 'studio-config.yaml'), ...)`. The `project.ts` also defines its own `TEMPLATES_DIR` (same value). This is acceptable — the two modules are independent.

So the refactor is simpler: just add the import and replace the inline project dir creation block. Remove only `PROJECT_SUBDIRS`. Keep `TEMPLATES_DIR` in both files.

### Step 3: Remove `PROJECT_SUBDIRS` from `init.ts`

Delete line:
```typescript
const PROJECT_SUBDIRS = ['pipelines', 'agents', 'contracts', 'tools', 'inputs'];
```

(It's now in `project.ts`.)

### Step 4: Run tests to verify nothing broke

```bash
pnpm --filter @studio/cli test
```

Expected: all existing tests still PASS (no regressions). The `createStudioStructure` tests cover the delegated behavior.

### Step 5: Commit

```bash
git add cli/src/commands/init.ts
git commit -m "refactor(cli): STU-42 — createStudioStructure delegates to createProjectDir"
```

---

## Task 3: Add `validateProjectName` and `projectAddDirect` (TDD)

**Files:**
- Modify: `cli/tests/commands/project.test.ts` (add new suites)
- Modify: `cli/src/commands/project.ts` (add functions)

### Step 1: Write failing tests

Append to `cli/tests/commands/project.test.ts`:

```typescript
describe('validateProjectName', () => {
  it('accepts valid lowercase alphanumeric names', async () => {
    const { validateProjectName } = await import('../../src/commands/project.js');
    expect(validateProjectName('software')).toBe(true);
    expect(validateProjectName('legal-analyzer')).toBe(true);
    expect(validateProjectName('my-project-v2')).toBe(true);
    expect(validateProjectName('x')).toBe(true);
    expect(validateProjectName('abc123')).toBe(true);
  });

  it('rejects names with uppercase letters', async () => {
    const { validateProjectName } = await import('../../src/commands/project.js');
    expect(validateProjectName('Legal')).not.toBe(true);
    expect(validateProjectName('MY-PROJECT')).not.toBe(true);
  });

  it('rejects names with leading or trailing hyphens', async () => {
    const { validateProjectName } = await import('../../src/commands/project.js');
    expect(validateProjectName('-legal')).not.toBe(true);
    expect(validateProjectName('legal-')).not.toBe(true);
  });

  it('rejects names with spaces or underscores', async () => {
    const { validateProjectName } = await import('../../src/commands/project.js');
    expect(validateProjectName('my project')).not.toBe(true);
    expect(validateProjectName('my_project')).not.toBe(true);
  });

  it('returns an error string (not false) for invalid names', async () => {
    const { validateProjectName } = await import('../../src/commands/project.js');
    const result = validateProjectName('Bad Name');
    expect(typeof result).toBe('string');
    expect(result).toContain('lowercase');
  });
});

describe('projectAddDirect', () => {
  it('creates project dirs with a valid name and no template', async () => {
    const { projectAddDirect } = await import('../../src/commands/project.js');
    const studioDir = join(TMP, '.studio');

    await projectAddDirect(studioDir, 'legal-analyzer');

    expect(await exists(join(PROJECTS_DIR, 'legal-analyzer', 'pipelines'))).toBe(true);
    expect(await exists(join(PROJECTS_DIR, 'legal-analyzer', 'agents'))).toBe(true);
  });

  it('creates project with software template', async () => {
    const { projectAddDirect } = await import('../../src/commands/project.js');
    const studioDir = join(TMP, '.studio');

    await projectAddDirect(studioDir, 'my-app', 'software');

    expect(await exists(join(PROJECTS_DIR, 'my-app', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);
  });

  it('throws on invalid project name', async () => {
    const { projectAddDirect } = await import('../../src/commands/project.js');
    const studioDir = join(TMP, '.studio');
    await expect(projectAddDirect(studioDir, 'Invalid Name')).rejects.toThrow('lowercase');
  });

  it('throws "already exists" when project already present', async () => {
    const { projectAddDirect } = await import('../../src/commands/project.js');
    const studioDir = join(TMP, '.studio');
    await projectAddDirect(studioDir, 'legal-analyzer');
    await expect(projectAddDirect(studioDir, 'legal-analyzer')).rejects.toThrow('already exists');
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter @studio/cli test
```

Expected: 9 failures — `validateProjectName is not a function`, `projectAddDirect is not a function`.

### Step 3: Implement in `project.ts`

Add after `createProjectDir`:

```typescript
/**
 * Validate a project name: lowercase alphanumeric + hyphens, no leading/trailing hyphens.
 * Returns true if valid, or an error string if not.
 */
export function validateProjectName(name: string): true | string {
  if (/^[a-z0-9][a-z0-9-]*$/.test(name) || /^[a-z0-9]$/.test(name)) {
    return true;
  }
  return 'Project name must be lowercase alphanumeric with hyphens (e.g. my-project)';
}

/**
 * Non-interactive project creation.
 * Validates name, then delegates to createProjectDir.
 */
export async function projectAddDirect(
  studioDir: string,
  projectName: string,
  templateName?: string,
  _description?: string
): Promise<void> {
  const validation = validateProjectName(projectName);
  if (validation !== true) {
    throw new Error(validation);
  }
  const projectsDir = join(studioDir, 'projects');
  await createProjectDir(projectsDir, projectName, templateName);
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter @studio/cli test
```

Expected: 9 new tests PASS, all prior tests still PASS.

### Step 5: Commit

```bash
git add cli/src/commands/project.ts cli/tests/commands/project.test.ts
git commit -m "feat(cli): STU-42 — validateProjectName + projectAddDirect (TDD)"
```

---

## Task 4: Add `projectAddWizard`, `projectCommand`, and register in `index.ts`

**Files:**
- Modify: `cli/src/commands/project.ts` (add wizard + command)
- Modify: `cli/src/index.ts` (register command)

No unit tests for wizard (requires interactive terminal). Manual smoke test in Task 5.

### Step 1: Add imports to `project.ts`

Add at the top of `cli/src/commands/project.ts`:

```typescript
import chalk from 'chalk';
import ora from 'ora';
import { input, select } from '@inquirer/prompts';
import { findStudioDir } from '../studio-dir.js';
import { listTemplates } from './templates.js';
```

### Step 2: Add `projectAddWizard` and `projectCommand` to `project.ts`

Append after `projectAddDirect`:

```typescript
/**
 * Interactive wizard for adding a project to an existing workspace.
 */
export async function projectAddWizard(studioDir: string): Promise<void> {
  // Step 1: Project name
  const rawName = await input({
    message: 'Project name:',
    validate: (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return 'Project name is required';
      const v = validateProjectName(trimmed);
      return v === true ? true : v;
    },
  });
  const projectName = rawName.trim();

  // Step 2: Description (optional, not persisted)
  await input({
    message: 'Description (optional, press Enter to skip):',
  });

  // Step 3: Template
  const templates = await listTemplates();
  const templateChoices = templates.map((t) => ({
    value: t.name,
    name: `${t.name} — ${t.description}`,
  }));

  const templateName = await select({
    message: 'Choose a template:',
    choices: templateChoices,
  });

  // Step 4: Create
  console.log('');
  const spinner = ora('Creating project...').start();
  try {
    await projectAddDirect(studioDir, projectName, templateName);
    spinner.stop();
  } catch (err) {
    spinner.fail('Failed');
    throw err;
  }

  // Step 5: Success output
  const projectsDir = join(studioDir, 'projects');
  for (const sub of PROJECT_SUBDIRS) {
    console.log(chalk.green(`  ✓ ${join(projectsDir, projectName, sub).replace(process.cwd() + '/', '')}/`));
  }
  console.log('');

  // Step 6: Next steps
  const selectedTemplate = templates.find((t) => t.name === templateName);
  const firstPipeline = selectedTemplate?.pipelines?.[0] ?? 'your-pipeline';
  console.log(chalk.bold('Done! Run your first pipeline:'));
  console.log(`  ${chalk.cyan(`studio run ${projectName}/${firstPipeline} --input "..."`)}`);
  console.log('');
}

/**
 * CLI dispatcher for `studio project <action> [args...]`.
 */
export async function projectCommand(
  action: string,
  args: string[],
  options: { template?: string; description?: string }
): Promise<void> {
  try {
    if (action !== 'add') {
      console.error(`Unknown project action: ${action}. Available: add`);
      process.exit(1);
    }

    // Require existing .studio/
    const cwd = process.cwd();
    const studioDir = await findStudioDir(cwd);
    if (!studioDir) {
      console.error(chalk.red('Studio is not initialized in this directory.'));
      console.log(`Run: ${chalk.cyan('studio init')}`);
      process.exit(1);
    }

    const nameArg = args[0];

    if (nameArg) {
      // Direct mode
      const spinner = ora('Creating project...').start();
      try {
        await projectAddDirect(studioDir, nameArg, options.template, options.description);
        spinner.stop();
      } catch (err) {
        spinner.fail('Failed');
        throw err;
      }

      const projectsDir = join(studioDir, 'projects');
      for (const sub of PROJECT_SUBDIRS) {
        console.log(chalk.green(`  ✓ ${join(projectsDir, nameArg, sub).replace(cwd + '/', '')}/`));
      }
      console.log('');

      const templates = await listTemplates();
      const selectedTemplate = templates.find((t) => t.name === (options.template ?? 'blank'));
      const firstPipeline = selectedTemplate?.pipelines?.[0] ?? 'your-pipeline';
      console.log(chalk.bold('Done! Run your first pipeline:'));
      console.log(`  ${chalk.cyan(`studio run ${nameArg}/${firstPipeline} --input "..."`)}`);
      console.log('');
    } else {
      // Wizard mode
      console.log('');
      await projectAddWizard(studioDir);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'ExitPromptError') {
      console.log('\nAborted.');
      process.exit(0);
    }
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
```

### Step 3: Register in `index.ts`

Add the import at the top of `cli/src/index.ts`:

```typescript
import { projectCommand } from './commands/project.js';
```

Add before `program.parse()`:

```typescript
program
  .command('project <action> [args...]')
  .description('Manage Studio projects (add)')
  .option('--template <name>', 'Template to use (blank, software, …)')
  .option('--description <desc>', 'Project description')
  .action(projectCommand);
```

### Step 4: Build to check types

```bash
pnpm build
```

Expected: Build completes without TypeScript errors.

### Step 5: Commit

```bash
git add cli/src/commands/project.ts cli/src/index.ts
git commit -m "feat(cli): STU-42 — projectAddWizard, projectCommand, register in index.ts"
```

---

## Task 5: Full verification + PR

### Step 1: Run all tests from root

```bash
pnpm test
```

Expected: all tests pass across all packages.

### Step 2: Build from root

```bash
pnpm build
```

Expected: `Build complete.` without errors.

### Step 3: Smoke test — direct mode (requires existing workspace)

```bash
cd /tmp
mkdir studio-smoke-42 && cd studio-smoke-42
node /home/arianeguay/dev/src/Studio/cli/dist/index.js init my-first-project \
  --template software \
  --provider anthropic \
  --api-key sk-ant-fake-key-smoke
```

Then add a second project:

```bash
node /home/arianeguay/dev/src/Studio/cli/dist/index.js project add legal-analyzer \
  --template blank
```

Expected output:
```
  ✓ .studio/projects/legal-analyzer/pipelines/
  ✓ .studio/projects/legal-analyzer/agents/
  ✓ .studio/projects/legal-analyzer/contracts/
  ✓ .studio/projects/legal-analyzer/tools/
  ✓ .studio/projects/legal-analyzer/inputs/

Done! Run your first pipeline:
  studio run legal-analyzer/your-pipeline --input "..."
```

### Step 4: Smoke test — error cases

```bash
# Already exists
node /home/arianeguay/dev/src/Studio/cli/dist/index.js project add legal-analyzer --template blank
```
Expected: `Error: Project 'legal-analyzer' already exists in ...`

```bash
# Invalid name
node /home/arianeguay/dev/src/Studio/cli/dist/index.js project add "Bad Name" --template blank
```
Expected: `Error: Project name must be lowercase alphanumeric with hyphens ...`

```bash
# Not initialized
cd /tmp && node /home/arianeguay/dev/src/Studio/cli/dist/index.js project add foo --template blank
```
Expected: `Studio is not initialized in this directory.`

### Step 5: Cleanup

```bash
rm -rf /tmp/studio-smoke-42
```

### Step 6: Create PR

```bash
git push -u origin HEAD
gh pr create \
  --title "feat(cli): STU-42 — studio project add wizard" \
  --body "$(cat <<'EOF'
## Summary

- **`studio project add`** — new command to add a project to an existing Studio workspace
- **Wizard mode**: `studio project add` — interactive prompts for name, description, template
- **Direct mode**: `studio project add <name> --template <t>` — no prompts
- **Validation**: project name (lowercase alphanumeric + hyphens), template existence, project uniqueness
- **Refactor**: extracted `createProjectDir` from `createStudioStructure` in `init.ts` — no behavior change

## Packages touched

- `@studio/cli` — `project.ts` (new), `init.ts` (refactor), `index.ts`, `project.test.ts` (new)

## How to test

```bash
pnpm --filter @studio/cli test

cd /tmp && mkdir test-42 && cd test-42
studio init my-app --template software --provider anthropic --api-key sk-ant-xxx
studio project add legal-analyzer --template blank
studio project add  # wizard mode
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" \
  --base main
```

---

## Acceptance Criteria Checklist

### Mode wizard
- [ ] `studio project add` launches wizard
- [ ] Prompts: name (with validation), description, template
- [ ] Lists templates from `listTemplates()`
- [ ] Creates `.studio/projects/<name>/` with 5 subdirs
- [ ] If template has `project/` subdir → copies files
- [ ] If blank template (no `project/` subdir) → creates empty dirs
- [ ] Shows next steps with `studio run` example

### Mode direct
- [ ] `studio project add <name> --template <t>` works without prompts
- [ ] `--description` flag accepted (optional)
- [ ] Clear error if project already exists
- [ ] Clear error if template invalid (with `studio templates list` hint)
- [ ] Clear error if project name invalid

### Not initialized
- [ ] `studio project add` without `.studio/` → friendly error + `studio init` hint

### Tests
- [ ] `createProjectDir` — 5 tests
- [ ] `validateProjectName` — 5 tests
- [ ] `projectAddDirect` — 4 tests
- [ ] All STU-38 init tests still green
