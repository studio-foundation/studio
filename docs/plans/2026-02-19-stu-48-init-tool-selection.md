# STU-48: Tool Selection Step in `studio init` Wizard — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an interactive checkbox step to the `studio init` wizard so users can choose which tools to install, with template-recommended tools pre-checked.

**Architecture:** Add `options?: { withTools?: boolean }` to `createProjectDir` in `project.ts` — when `false`, the `cp()` call skips the `tools/` subdirectory via a filter. Thread this flag through `createStudioStructure` and `directInit`. In wizard mode, call `createStudioStructure` with `withTools: false`, then show a checkbox using existing `listAvailableTools()` / `toolsAddDirect()`, and install the selection. Direct mode is unchanged unless `--no-tools` is passed.

**Tech Stack:** TypeScript, Node.js `fs.cp` filter API, `@inquirer/prompts`'s `checkbox` (already in use in `tools.ts`), existing `listAvailableTools` + `toolsAddDirect` exports from `tools.ts`

**Working directory:** `/home/arianeguay/dev/src/Studio`

---

## Task 1 — `createProjectDir`: add `withTools` option

**Files:**
- Modify: `cli/src/commands/project.ts`
- Modify: `cli/tests/commands/project.test.ts` (append new `describe` block)

### Step 1: Write the failing tests

Append this `describe` block at the end of `cli/tests/commands/project.test.ts`, before the final `}`s of the file (after the `validateProjectName` tests):

```typescript
describe('createProjectDir with { withTools: false }', () => {
  it('copies software template files but leaves tools/ empty', async () => {
    const { createProjectDir } = await import('../../src/commands/project.js');
    await createProjectDir(PROJECTS_DIR, 'my-app', 'software', { withTools: false });

    // Non-tool template files are copied
    expect(await exists(join(PROJECTS_DIR, 'my-app', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);
    expect(await exists(join(PROJECTS_DIR, 'my-app', 'agents', 'coder.agent.yaml'))).toBe(true);

    // tools/ directory exists but is empty
    expect(await exists(join(PROJECTS_DIR, 'my-app', 'tools'))).toBe(true);
    const toolFiles = await readdir(join(PROJECTS_DIR, 'my-app', 'tools'));
    expect(toolFiles).toEqual([]);
  });

  it('blank template with { withTools: false } still creates all 5 subdirs including tools/', async () => {
    const { createProjectDir } = await import('../../src/commands/project.js');
    await createProjectDir(PROJECTS_DIR, 'my-blank', 'blank', { withTools: false });

    for (const sub of ['pipelines', 'agents', 'contracts', 'tools', 'inputs']) {
      expect(await exists(join(PROJECTS_DIR, 'my-blank', sub))).toBe(true);
    }
  });

  it('default behavior (withTools: true) still copies tools', async () => {
    const { createProjectDir } = await import('../../src/commands/project.js');
    await createProjectDir(PROJECTS_DIR, 'my-app', 'software');

    expect(await exists(join(PROJECTS_DIR, 'my-app', 'tools', 'repo-manager.tool.yaml'))).toBe(true);
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter @studio/cli test -- --reporter=verbose 2>&1 | grep -E "withTools|FAIL|Cannot"
```

Expected: tests fail because `createProjectDir` doesn't accept a fourth argument yet.

### Step 3: Implement the change

In `cli/src/commands/project.ts`:

**a) Add `relative` and `sep` to the path import:**
```typescript
import { resolve, join, relative, sep } from 'node:path';
```

**b) Update the function signature:**
```typescript
export async function createProjectDir(
  projectsDir: string,
  projectName: string,
  templateName?: string,
  options?: { withTools?: boolean }
): Promise<void> {
```

**c) Add `withTools` resolution at the top of the function body (after the signature), before the existing checks:**
```typescript
  const withTools = options?.withTools ?? true;
```

**d) Replace the `cp()` call inside the `if (hasProjectDir)` branch:**

Current code:
```typescript
    if (hasProjectDir) {
      await mkdir(projectDir, { recursive: true });
      await cp(templateProjectDir, projectDir, { recursive: true });
    } else {
```

Replace with:
```typescript
    if (hasProjectDir) {
      await mkdir(projectDir, { recursive: true });
      if (withTools) {
        await cp(templateProjectDir, projectDir, { recursive: true });
      } else {
        await cp(templateProjectDir, projectDir, {
          recursive: true,
          filter: (src) => {
            const rel = relative(templateProjectDir, src);
            return rel !== 'tools' && !rel.startsWith('tools' + sep);
          },
        });
        await mkdir(join(projectDir, 'tools'), { recursive: true });
      }
    } else {
```

### Step 4: Run the tests to verify they pass

```bash
pnpm --filter @studio/cli test -- --reporter=verbose 2>&1 | grep -E "withTools|✓|✗|FAIL|PASS" | head -20
```

Expected: all 3 new tests pass. Existing `createProjectDir` tests also pass.

### Step 5: Build to catch TypeScript errors

```bash
pnpm build 2>&1 | tail -10
```

Expected: no errors.

### Step 6: Commit

```bash
git add cli/src/commands/project.ts cli/tests/commands/project.test.ts
git commit -m "feat(cli): STU-48 — createProjectDir supports withTools option to skip tools/ copy"
```

---

## Task 2 — Thread `withTools` through `createStudioStructure` and `directInit`

**Files:**
- Modify: `cli/src/commands/init.ts`
- Modify: `cli/tests/commands/init.test.ts` (append new tests)

### Step 1: Write the failing tests

Append to `cli/tests/commands/init.test.ts`, after the existing `directInit` describe block:

```typescript
describe('createStudioStructure with withTools: false', () => {
  it('does not copy tool files from template', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP, 'software', 'software', false);

    const toolsDir = resolve(TMP, '.studio', 'projects', 'software', 'tools');
    expect(await exists(toolsDir)).toBe(true);

    const { readdir } = await import('node:fs/promises');
    const toolFiles = await readdir(toolsDir);
    expect(toolFiles).toEqual([]);
  });

  it('still copies other template files when withTools is false', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP, 'software', 'software', false);

    expect(await exists(resolve(TMP, '.studio', 'projects', 'software', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'software', 'agents', 'coder.agent.yaml'))).toBe(true);
  });
});

describe('directInit with noTools: true', () => {
  it('creates project without copying tool files', async () => {
    const { directInit } = await import('../../src/commands/init.js');
    await directInit(TMP, 'my-project', 'software', 'anthropic', 'sk-ant-key', true);

    const toolsDir = resolve(TMP, '.studio', 'projects', 'my-project', 'tools');
    expect(await exists(toolsDir)).toBe(true);

    const { readdir } = await import('node:fs/promises');
    const toolFiles = await readdir(toolsDir);
    expect(toolFiles).toEqual([]);
  });

  it('still creates config.yaml when noTools is true', async () => {
    const { directInit } = await import('../../src/commands/init.js');
    await directInit(TMP, 'my-project', 'software', 'anthropic', 'sk-ant-key', true);

    expect(await exists(resolve(TMP, '.studio', 'config.yaml'))).toBe(true);
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter @studio/cli test -- --reporter=verbose 2>&1 | grep -E "withTools|noTools|FAIL"
```

Expected: tests fail — `createStudioStructure` and `directInit` don't accept the new params yet.

### Step 3: Update `createStudioStructure`

In `cli/src/commands/init.ts`, update the function signature:

```typescript
export async function createStudioStructure(
  cwd: string,
  projectName = 'default',
  templateName?: string,
  withTools = true
): Promise<void> {
```

And in the body, pass `withTools` to `createProjectDir`:

Current:
```typescript
  await createProjectDir(projectsDir, projectName, templateName);
```

Replace with:
```typescript
  await createProjectDir(projectsDir, projectName, templateName, { withTools });
```

### Step 4: Update `directInit`

Current signature:
```typescript
export async function directInit(
  cwd: string,
  projectName: string,
  templateName: string,
  provider: string,
  apiKey: string
): Promise<void> {
```

New signature:
```typescript
export async function directInit(
  cwd: string,
  projectName: string,
  templateName: string,
  provider: string,
  apiKey: string,
  noTools = false
): Promise<void> {
```

And update the `createStudioStructure` call inside `directInit`:

Current:
```typescript
  await createStudioStructure(cwd, projectName, templateName);
```

Replace with:
```typescript
  await createStudioStructure(cwd, projectName, templateName, !noTools);
```

### Step 5: Run the tests

```bash
pnpm --filter @studio/cli test -- --reporter=verbose 2>&1 | grep -E "withTools|noTools|✓|✗|FAIL|PASS" | head -30
```

Expected: all 4 new tests pass. All existing tests also pass.

### Step 6: Build

```bash
pnpm build 2>&1 | tail -10
```

Expected: no errors.

### Step 7: Commit

```bash
git add cli/src/commands/init.ts cli/tests/commands/init.test.ts
git commit -m "feat(cli): STU-48 — thread withTools through createStudioStructure and directInit"
```

---

## Task 3 — Wizard tool selection step + `--no-tools` CLI flag

**Files:**
- Modify: `cli/src/commands/init.ts`
- Modify: `cli/src/index.ts`

No new unit tests for this task — the wizard step is interactive and can't be unit-tested without mocking `@inquirer/prompts`. The `toolsAddDirect` logic is already tested in `cli/tests/commands/tools.test.ts`.

### Step 1: Add imports to `init.ts`

**a) Add `checkbox` to the `@inquirer/prompts` import:**

Current:
```typescript
import { input, select, password, confirm } from '@inquirer/prompts';
```

New:
```typescript
import { input, select, password, confirm, checkbox } from '@inquirer/prompts';
```

**b) Add import for tools helpers (after the existing local imports):**
```typescript
import { listAvailableTools, toolsAddDirect } from './tools.js';
```

### Step 2: Update `InitOptions` interface

The Commander `--no-tools` flag creates an option named `tools` (boolean). Add it to the interface:

Current:
```typescript
interface InitOptions {
  template?: string;
  project?: string;
  provider?: string;
  apiKey?: string;
  force?: boolean;
  yes?: boolean;
}
```

New:
```typescript
interface InitOptions {
  template?: string;
  project?: string;
  provider?: string;
  apiKey?: string;
  force?: boolean;
  yes?: boolean;
  tools?: boolean;  // false when --no-tools is passed, true otherwise
}
```

### Step 3: Update direct mode in `initCommand` to pass `noTools`

In `initCommand`, inside the `if (isDirectMode)` block, find:
```typescript
      await directInit(cwd, projectName, options.template!, options.provider!, options.apiKey ?? '');
```

Replace with:
```typescript
      await directInit(cwd, projectName, options.template!, options.provider!, options.apiKey ?? '', options.tools === false);
```

### Step 4: Add the tool selection step to wizard mode

In the wizard section, find the comment `// Step 6: Create structure` and the code that follows it. Replace the entire block from `// Step 6` through `// Step 7: Success output` with:

```typescript
    // Step 6: Tool selection
    const availableTools = await listAvailableTools();
    let selectedTools: string[] = [];

    if (availableTools.length > 0) {
      const selectedTemplateMeta = templates.find((t) => t.name === templateName);
      const recommended = new Set(selectedTemplateMeta?.tools_included ?? []);

      const toolChoices = availableTools.map((t) => ({
        value: t.name,
        name: `${t.name} — ${t.description}`,
        checked: recommended.has(t.name),
      }));

      console.log('');
      selectedTools = await checkbox({
        message: 'Select tools to install:',
        choices: toolChoices,
      });
    }

    // Step 7: Create structure (without tools — we install them below)
    console.log('');
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

    // Step 8: Install selected tools
    if (selectedTools.length > 0) {
      await toolsAddDirect(studioDir, projectName, selectedTools);
    }

    // Step 9: Success output
    console.log(chalk.green(`  ✓ .studio/config.yaml`));
    console.log(chalk.green(`  ✓ .studio/projects/${projectName}/`));
    console.log(chalk.green(`  ✓ Applied template: ${templateName}`));
    console.log(chalk.green(`  ✓ Updated .gitignore`));
    if (selectedTools.length > 0) {
      console.log(chalk.green(`  ✓ Installed tools: ${selectedTools.join(', ')}`));
    }
    console.log('');
```

**Note:** The wizard previously had `// Step 6: Create structure` and `// Step 7: Success output`. These are now renumbered 7, 8, 9 above. Delete the old Steps 6 and 7 entirely — replace them with the new block above.

### Step 5: Add the `--no-tools` flag to the CLI

In `cli/src/index.ts`, find the `studio init` command definition and add the new option:

Current (ends at `--yes`):
```typescript
  .option('--force', 'Backup existing .studio/ and reinitialize')
  .option('--yes', 'Skip confirmation prompts (for CI/CD)')
  .action(initCommand);
```

New:
```typescript
  .option('--force', 'Backup existing .studio/ and reinitialize')
  .option('--yes', 'Skip confirmation prompts (for CI/CD)')
  .option('--no-tools', 'Skip tool installation (direct mode only)')
  .action(initCommand);
```

### Step 6: Build to verify no TypeScript errors

```bash
pnpm build 2>&1 | tail -15
```

Expected: no errors. If there are import errors, check that `listAvailableTools` and `toolsAddDirect` are exported from `tools.ts` (they are).

### Step 7: Run the full test suite

```bash
pnpm test 2>&1 | tail -20
```

Expected: all tests pass (same pass/skip counts as before — no new failures).

### Step 8: Commit

```bash
git add cli/src/commands/init.ts cli/src/index.ts
git commit -m "feat(cli): STU-48 — add tool selection step to studio init wizard + --no-tools flag"
```

---

## Task 4 — Acceptance criteria verification

### Step 1: Smoke test the wizard (manual)

Run in a temp directory:
```bash
mkdir /tmp/stu-48-test && cd /tmp/stu-48-test
node /home/arianeguay/dev/src/Studio/cli/dist/index.js init
```

Walk through the wizard. When the tool selection step appears:
- Confirm software template shows repo-manager, search, shell pre-checked
- Confirm git is unchecked
- Select a subset and complete the wizard
- Verify `ls .studio/projects/<name>/tools/` shows only the selected tools

### Step 2: Smoke test direct mode with `--no-tools`

```bash
rm -rf /tmp/stu-48-direct && mkdir /tmp/stu-48-direct && cd /tmp/stu-48-direct
node /home/arianeguay/dev/src/Studio/cli/dist/index.js init \
  --template software --provider later --no-tools
ls .studio/projects/stu-48-direct/tools/
```

Expected: `tools/` directory exists but is empty.

### Step 3: Smoke test direct mode without `--no-tools` (unchanged behavior)

```bash
rm -rf /tmp/stu-48-default && mkdir /tmp/stu-48-default && cd /tmp/stu-48-default
node /home/arianeguay/dev/src/Studio/cli/dist/index.js init \
  --template software --provider later
ls .studio/projects/stu-48-default/tools/
```

Expected: `repo-manager.tool.yaml`, `search.tool.yaml`, `shell.tool.yaml` are present (copied from template).

### Step 4: Final test run

```bash
pnpm test 2>&1 | tail -10
```

Expected: all tests pass.

### Step 5: Git log

```bash
git log --oneline -4
```

Expected: 3 commits for this feature.

---

## Acceptance Criteria Checklist

| AC | Status |
|----|--------|
| Wizard proposes tool selection after provider config | Task 3 — wizard Step 6 |
| Tools proposed match template (or all if blank) | `tools_included` from metadata, blank = all unchecked |
| Already installed tools marked as disabled | Handled by `toolsAddDirect` (skips existing) — re-init with `--force` edge case |
| Direct mode: skip interactivity, template tools installed | Default behavior unchanged (Task 2) |
| `--no-tools` flag skips installation in direct mode | Task 3 — `--no-tools` + `noTools` param |
| Success message includes installed tools | Task 3 — `✓ Installed tools: ...` line |
