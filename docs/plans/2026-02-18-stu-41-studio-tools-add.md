# STU-41: `studio tools add` wizard — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add wizard mode and multi-tool direct mode to `studio tools add`, plus skip-if-installed behavior.

**Architecture:** Extend the existing `'add'` case in `toolsCommand` (Approach A — minimal refactor). Add two new exported helpers: `listAvailableTools` (reads tool templates from disk) and `toolsAddDirect` (installs one or many tools, skips already-installed). When `args` is empty, run inline wizard; when `args` has items, run direct mode. No changes to any other command case or to `index.ts`.

**Tech Stack:** TypeScript, `@inquirer/prompts` v8 (`select`, `checkbox`), `js-yaml`, `chalk`, `ora`, `node:fs/promises`.

---

### Task 1: Add `listAvailableTools` helper + tests

**Files:**
- Modify: `cli/src/commands/tools.ts`
- Modify: `cli/tests/commands/tools.test.ts`

**Step 1: Write the failing tests**

Add to `cli/tests/commands/tools.test.ts` after the existing `describe('getToolsDir', ...)` block:

```typescript
import { listAvailableTools } from '../../src/commands/tools.js';

describe('listAvailableTools', () => {
  it('returns all available tool templates', async () => {
    const tools = await listAvailableTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('git');
    expect(names).toContain('repo-manager');
    expect(names).toContain('shell');
    expect(names).toContain('search');
  });

  it('returns description for each tool', async () => {
    const tools = await listAvailableTools();
    for (const t of tools) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it('returns tools sorted by name', async () => {
    const tools = await listAvailableTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm --filter @studio/cli test 2>&1 | grep -A3 "listAvailableTools"
```

Expected: FAIL — `listAvailableTools is not a function` or similar.

**Step 3: Add `listAvailableTools` to `cli/src/commands/tools.ts`**

Add after the existing imports (already has `readFile`, `readdir`; add `load` from `js-yaml`):

```typescript
import { load } from 'js-yaml';
```

Then add the function after the `TOOL_TEMPLATES_DIR` constant:

```typescript
export async function listAvailableTools(): Promise<{ name: string; description: string }[]> {
  const entries = await readdir(TOOL_TEMPLATES_DIR);
  const yamlFiles = entries.filter((f) => f.endsWith('.tool.yaml')).sort();
  const tools: { name: string; description: string }[] = [];
  for (const file of yamlFiles) {
    const content = await readFile(resolve(TOOL_TEMPLATES_DIR, file), 'utf-8');
    const parsed = load(content) as { name?: string; description?: string };
    const toolName = file.replace('.tool.yaml', '');
    tools.push({
      name: toolName,
      description: parsed.description ?? '',
    });
  }
  return tools;
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio/cli test 2>&1 | grep -A5 "listAvailableTools"
```

Expected: all 3 tests PASS.

**Step 5: Commit**

```bash
git add cli/src/commands/tools.ts cli/tests/commands/tools.test.ts
git commit -m "feat(cli): STU-41 — add listAvailableTools helper"
```

---

### Task 2: Add `toolsAddDirect` helper + tests

**Files:**
- Modify: `cli/src/commands/tools.ts`
- Modify: `cli/tests/commands/tools.test.ts`

**Step 1: Write the failing tests**

Add to `cli/tests/commands/tools.test.ts`. Important: use `/tmp` for the studio dir, not a repo subdirectory (the repo has `.studio/` at its root which would be found by `findStudioDir`).

```typescript
import { toolsAddDirect } from '../../src/commands/tools.js';
import { access } from 'node:fs/promises';

const TOOLS_TMP = resolve('/tmp', '.studio-tools-add-test-' + Math.floor(Date.now() / 1000));
const TOOLS_STUDIO_DIR = resolve(TOOLS_TMP, '.studio');
const TEST_PROJECT = 'software';

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe('toolsAddDirect', () => {
  beforeEach(async () => {
    await mkdir(resolve(TOOLS_STUDIO_DIR, 'projects', TEST_PROJECT, 'tools'), { recursive: true });
  });
  afterEach(async () => {
    await rm(TOOLS_TMP, { recursive: true, force: true });
  });

  it('installs a single valid tool', async () => {
    const result = await toolsAddDirect(TOOLS_STUDIO_DIR, TEST_PROJECT, ['git']);
    expect(result.installed).toEqual(['git']);
    expect(result.skipped).toEqual([]);
    const toolPath = resolve(TOOLS_STUDIO_DIR, 'projects', TEST_PROJECT, 'tools', 'git.tool.yaml');
    expect(await fileExists(toolPath)).toBe(true);
  });

  it('installs multiple tools in one call', async () => {
    const result = await toolsAddDirect(TOOLS_STUDIO_DIR, TEST_PROJECT, ['git', 'shell']);
    expect(result.installed).toContain('git');
    expect(result.installed).toContain('shell');
    expect(result.skipped).toEqual([]);
  });

  it('skips already-installed tool and returns it in skipped list', async () => {
    await toolsAddDirect(TOOLS_STUDIO_DIR, TEST_PROJECT, ['git']);
    const result = await toolsAddDirect(TOOLS_STUDIO_DIR, TEST_PROJECT, ['git', 'shell']);
    expect(result.installed).toEqual(['shell']);
    expect(result.skipped).toEqual(['git']);
  });

  it('throws on unknown tool name', async () => {
    await expect(toolsAddDirect(TOOLS_STUDIO_DIR, TEST_PROJECT, ['nonexistent'])).rejects.toThrow("Unknown tool 'nonexistent'");
  });

  it('creates tools dir if it does not exist', async () => {
    await rm(resolve(TOOLS_STUDIO_DIR, 'projects', TEST_PROJECT, 'tools'), { recursive: true, force: true });
    const result = await toolsAddDirect(TOOLS_STUDIO_DIR, TEST_PROJECT, ['search']);
    expect(result.installed).toEqual(['search']);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
pnpm --filter @studio/cli test 2>&1 | grep -A3 "toolsAddDirect"
```

Expected: FAIL — `toolsAddDirect is not a function`.

**Step 3: Add `toolsAddDirect` to `cli/src/commands/tools.ts`**

Add `access` to the existing `node:fs/promises` import:

```typescript
import { readdir, readFile, writeFile, unlink, mkdir, access } from 'node:fs/promises';
```

Then add the function after `listAvailableTools`:

```typescript
export async function toolsAddDirect(
  studioDir: string,
  project: string,
  toolNames: string[]
): Promise<{ installed: string[]; skipped: string[] }> {
  const toolsDir = getToolsDir(studioDir, project);
  await mkdir(toolsDir, { recursive: true });

  const installed: string[] = [];
  const skipped: string[] = [];

  for (const name of toolNames) {
    const templatePath = resolve(TOOL_TEMPLATES_DIR, `${name}.tool.yaml`);
    let templateContent: string;
    try {
      templateContent = await readFile(templatePath, 'utf-8');
    } catch {
      const available = await listAvailableTools();
      throw new Error(`Unknown tool '${name}'. Available: ${available.map((t) => t.name).join(', ')}`);
    }

    const destPath = resolve(toolsDir, `${name}.tool.yaml`);
    const alreadyInstalled = await access(destPath).then(() => true).catch(() => false);
    if (alreadyInstalled) {
      skipped.push(name);
      continue;
    }

    await writeFile(destPath, templateContent, 'utf-8');
    installed.push(name);
  }

  return { installed, skipped };
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio/cli test 2>&1 | grep -A5 "toolsAddDirect"
```

Expected: all 5 tests PASS.

**Step 5: Commit**

```bash
git add cli/src/commands/tools.ts cli/tests/commands/tools.test.ts
git commit -m "feat(cli): STU-41 — add toolsAddDirect helper with skip-if-installed"
```

---

### Task 3: Wire direct mode in `toolsCommand`

**Files:**
- Modify: `cli/src/commands/tools.ts`

Replace the existing `'add'` case (lines 90–114) with a new implementation that handles multiple tool names and uses `toolsAddDirect`.

**Step 1: Replace the `'add'` case**

Replace the current `case 'add':` block with:

```typescript
case 'add': {
  if (args.length === 0) {
    // Wizard mode — handled in Task 4
    console.error('Usage: studio tools add <name> [name...] --project <project>');
    console.error('Run without args for interactive wizard (coming soon).');
    process.exit(1);
  }

  // Direct mode: args = tool names
  const { studioDir, project } = await (async () => {
    const config = await loadConfig();
    const sd = config.resolvedStudioDir;
    if (!sd) {
      console.error("Error: No .studio/ directory found. Run 'studio init' first.");
      process.exit(1);
    }
    const { toolsDir: _ignored, project } = await resolveProjectToolsDir(options.project);
    return { studioDir: sd, project };
  })();

  const { installed, skipped } = await toolsAddDirect(studioDir, project, args);

  for (const name of installed) {
    console.log(chalk.green(`  ✓ ${name}.tool.yaml`));
  }
  for (const name of skipped) {
    console.log(chalk.yellow(`  ⚠ ${name} already installed, skipping`));
  }

  if (installed.length > 0) {
    console.log(`\nDone! ${installed.length} tool${installed.length > 1 ? 's' : ''} installed in '${project}'.`);
  } else {
    console.log('\nNo new tools installed.');
  }
  break;
}
```

Note: `resolveProjectToolsDir` handles the case where studioDir is missing and the multi-project error when `--project` is not specified. We only need `studioDir` for `toolsAddDirect`, so extract it from `loadConfig`.

Actually, simplify: `toolsAddDirect` takes `studioDir` and `project`. The cleanest way to get both from the existing infrastructure is to use `loadConfig` for `studioDir` and `resolveProjectToolsDir` for `project`. But `resolveProjectToolsDir` calls `loadConfig` internally, so call it once:

```typescript
case 'add': {
  if (args.length === 0) {
    // Wizard mode — handled in Task 4
    console.error('Usage: studio tools add <name> [name...] --project <project>');
    console.error('(Or run without args for interactive wizard once STU-41 is fully implemented)');
    process.exit(1);
  }

  // Direct mode
  const { project } = await resolveProjectToolsDir(options.project);
  const config = await loadConfig();
  const studioDir = config.resolvedStudioDir!;

  const { installed, skipped } = await toolsAddDirect(studioDir, project, args);

  for (const name of installed) {
    console.log(chalk.green(`  ✓ ${name}.tool.yaml`));
  }
  for (const name of skipped) {
    console.log(chalk.yellow(`  ⚠ ${name} already installed, skipping`));
  }
  console.log('');
  if (installed.length > 0) {
    console.log(`Done! ${installed.length} tool${installed.length > 1 ? 's' : ''} installed in '${project}'.`);
  } else {
    console.log('No new tools installed.');
  }
  break;
}
```

**Step 2: Build and smoke-test**

```bash
pnpm build
```

Expected: builds without errors.

**Step 3: Run tests**

```bash
pnpm --filter @studio/cli test
```

Expected: all tests PASS (including existing ones).

**Step 4: Commit**

```bash
git add cli/src/commands/tools.ts
git commit -m "feat(cli): STU-41 — wire multi-tool direct mode in tools add"
```

---

### Task 4: Add wizard mode

**Files:**
- Modify: `cli/src/commands/tools.ts`

**Step 1: Add `checkbox` and `select` imports**

The existing import in `tools.ts` doesn't use `@inquirer/prompts`. Add at the top:

```typescript
import { select, checkbox } from '@inquirer/prompts';
```

**Step 2: Replace the wizard placeholder with real wizard logic**

Replace the `if (args.length === 0)` block (the placeholder from Task 3) with:

```typescript
if (args.length === 0) {
  // Wizard mode
  const config = await loadConfig();
  const studioDir = config.resolvedStudioDir;
  if (!studioDir) {
    console.error("Error: No .studio/ directory found. Run 'studio init' first.");
    process.exit(1);
  }

  // Discover projects
  const projectsDir = resolve(studioDir, 'projects');
  let projectEntries: string[];
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    projectEntries = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    projectEntries = [];
  }

  if (projectEntries.length === 0) {
    console.error(chalk.red("No projects found. Run 'studio project add' first."));
    process.exit(1);
  }

  // Select project
  let selectedProject: string;
  if (options.project) {
    selectedProject = options.project;
  } else if (projectEntries.length === 1) {
    selectedProject = projectEntries[0]!;
  } else {
    selectedProject = await select({
      message: 'Which project?',
      choices: projectEntries.map((p) => ({ value: p, name: p })),
    });
  }

  // Select tools via checkbox
  console.log('');
  const available = await listAvailableTools();
  const alreadyInstalled = await listTools(getToolsDir(studioDir, selectedProject));

  const choices = available.map((t) => ({
    value: t.name,
    name: `${t.name} — ${t.description}`,
    disabled: alreadyInstalled.includes(t.name) ? '(already installed)' : false,
  }));

  const selected: string[] = await checkbox({
    message: 'Select tools to install:',
    choices,
  });

  if (selected.length === 0) {
    console.log('No tools selected.');
    break;
  }

  // Install
  console.log('\nInstalling tools...');
  const { installed, skipped } = await toolsAddDirect(studioDir, selectedProject, selected);

  for (const name of installed) {
    console.log(chalk.green(`  ✓ ${name}.tool.yaml`));
  }
  for (const name of skipped) {
    console.log(chalk.yellow(`  ⚠ ${name} already installed, skipping`));
  }
  console.log('');
  console.log(`Done! ${installed.length} tool${installed.length !== 1 ? 's' : ''} installed in '${selectedProject}'.`);
  break;
}
```

Note: The `alreadyInstalled` check with `disabled` in checkbox choices gives users visual feedback about what's already installed without blocking them — but since `disabled` items can't be selected, they won't be re-installed anyway. Alternatively, if you want already-installed tools to be selectable (and just skipped), remove the `disabled` property. Use `disabled` to keep the UX clean.

**Step 3: Build**

```bash
pnpm build
```

Expected: no TypeScript errors.

**Step 4: Run tests**

```bash
pnpm --filter @studio/cli test
```

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add cli/src/commands/tools.ts
git commit -m "feat(cli): STU-41 — add tools add wizard (project select + checkbox)"
```

---

### Task 5: Remove old single-tool install code + final cleanup

**Files:**
- Modify: `cli/src/commands/tools.ts`

After Tasks 3 and 4 are in place, the old inline install logic (the original `'add'` case that required `args[0]`, called `resolveProjectToolsDir` alone, and used `readFile`/`writeFile` directly) is gone. Verify there's no dead code.

**Step 1: Check for dead code**

- The old `readFile` in `'add'` is replaced by `toolsAddDirect` which uses `readFile` internally — no dead import.
- The `writeFile` import is still used by... check if it's still used elsewhere in the file. If only `toolsAddDirect` uses it (internally) — and since `toolsAddDirect` itself uses `writeFile` directly — it should still be imported. Verify.

**Step 2: Full test run**

```bash
pnpm --filter @studio/cli test
```

Expected: all tests PASS.

**Step 3: Build the whole monorepo**

```bash
pnpm build
```

Expected: zero errors.

**Step 4: Final commit (if any cleanup was needed)**

```bash
git add cli/src/commands/tools.ts
git commit -m "chore(cli): STU-41 — cleanup dead code in tools.ts"
```

If no cleanup was needed, skip this commit.

---

### Task 6: Create feature branch, push, open PR

**Step 1: Check current branch**

```bash
git branch --show-current
```

If already on a feature branch (e.g. `arianedguay/stu-41-studio-tools-add-wizard`), skip Step 2.

**Step 2: Create feature branch (if on main)**

```bash
git checkout -b arianedguay/stu-41-studio-tools-add-wizard
```

**Step 3: Push and open PR**

```bash
git push -u origin arianedguay/stu-41-studio-tools-add-wizard
gh pr create \
  --title "feat(cli): STU-41 — studio tools add wizard" \
  --body "$(cat <<'EOF'
## What

Adds wizard and multi-tool direct mode to `studio tools add`.

## Why

Previously `studio tools add` required a single tool name and exited with an error if not provided. This PR adds an interactive wizard for discovery and selection, making the DX consistent with `studio project add`.

## Changes

- `listAvailableTools()` — reads tool templates from disk, returns name + description
- `toolsAddDirect(studioDir, project, toolNames[])` — installs multiple tools, skips already-installed
- `toolsCommand 'add'` case — dispatches to wizard (no args) or direct (args provided)
- Wizard: project select (skipped if 1 project), checkbox multi-select with descriptions from YAML

## Packages touched

- `@studio/cli`

## How to test

\`\`\`bash
# Wizard mode (in a dir with .studio/)
studio tools add

# Direct mode
studio tools add git shell --project software

# Already installed
studio tools add git --project software  # ⚠ skipped
\`\`\`
EOF
)" \
  --base main
```

---

## Notes

- `resolveProjectToolsDir` is unchanged — direct mode still uses it for project resolution when `--project` is not specified and multiple projects exist.
- The `disabled` property in `checkbox` choices prevents already-installed tools from being re-selected. If you prefer to allow re-selection (and silently skip), remove `disabled`.
- All interactive wizard code is in `toolsCommand` — not exported, not tested directly (same pattern as `projectAddWizard` in `project.ts`).
