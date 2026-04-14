# Design: STU-48 — Tool Selection Step in `studio init` Wizard

**Date:** 2026-02-19
**Issue:** [STU-48](https://linear.app/studioag/issue/STU-48/studio-init-tool-selection-step-during-wizard)
**Package:** `@studio-foundation/cli`

---

## Problem

The `studio init` wizard creates a project structure from a template but doesn't give users control over which tools are installed. Tools are silently bundled from the template's `project/tools/` directory via `cp()`. Users who want to add `git` or remove `shell` must do so manually after init via `studio tools add / remove`.

---

## Approach: Skip-tools flag + wizard checkbox

Add `options?: { withTools?: boolean }` to `createProjectDir`. In wizard mode, set `withTools: false` so `cp()` skips the `tools/` subdirectory. A new checkbox step then lets the user pick tools; `toolsAddDirect` installs the selection. Direct mode is unchanged (template tools copy as before).

### Why this approach

- Minimal blast radius: one boolean flag threaded through two functions
- No template file removal — existing template `project/tools/` files remain for direct mode
- Reuses `listAvailableTools()`, `toolsAddDirect()`, and `checkbox` from `@inquirer/prompts` — all already available
- Template metadata's `tools_included` already lists recommended tools for each template

---

## Wizard UX

New step inserted **after model selection, before project creation**:

```
? Select tools to install:
  ◉ repo-manager — Read and write files in the workspace     ← pre-checked (tools_included)
  ◉ search — Search the codebase by content or file pattern  ← pre-checked
  ◉ shell — Execute shell commands in the workspace          ← pre-checked
  ◯ git — Git version control operations                     ← unchecked
```

- `tools_included` from template metadata determines which are pre-checked
- For `blank` template (no `tools_included`): all tools shown, none pre-checked
- If no tool templates exist in `cli/templates/tools/`: step is skipped silently
- After structure creation, `toolsAddDirect(studioDir, projectName, selectedTools)` installs the selection

Success message:
```
  ✓ .studio/config.yaml
  ✓ .studio/projects/my-app/
  ✓ Applied template: software
  ✓ Updated .gitignore
  ✓ Installed tools: repo-manager, search, shell
```

If no tools selected: no tool line in the success output.

---

## Direct Mode

```bash
# Default: tools from template copied unchanged (existing behavior)
studio init --template software --provider anthropic --api-key $KEY

# New flag: skip tool installation entirely
studio init --template software --provider anthropic --api-key $KEY --no-tools
```

`--no-tools` sets `withTools: false`, creating an empty `tools/` dir.

---

## Implementation

### `createProjectDir` in `project.ts`

Add optional third argument `options?: { withTools?: boolean }` (default: `true`).

When `withTools: false` and the template has a `project/` subdir:
- Use `cp()` with a `filter` that excludes the `tools/` subdirectory
- Create an empty `tools/` dir manually afterward

```typescript
export async function createProjectDir(
  projectsDir: string,
  projectName: string,
  templateName?: string,
  options?: { withTools?: boolean }
): Promise<void> {
  const withTools = options?.withTools ?? true;
  // ...existing checks...
  if (hasProjectDir) {
    await mkdir(projectDir, { recursive: true });
    if (withTools) {
      await cp(templateProjectDir, projectDir, { recursive: true });
    } else {
      const toolsPath = join(templateProjectDir, 'tools');
      await cp(templateProjectDir, projectDir, {
        recursive: true,
        filter: (src) => !src.startsWith(toolsPath),
      });
      await mkdir(join(projectDir, 'tools'), { recursive: true });
    }
  } else {
    // blank template path: empty subdirs as before
  }
}
```

### `createStudioStructure` in `init.ts`

Add `withTools = true` parameter, pass to `createProjectDir`:

```typescript
export async function createStudioStructure(
  cwd: string,
  projectName = 'default',
  templateName?: string,
  withTools = true
): Promise<void> {
  // ...
  await createProjectDir(projectsDir, projectName, templateName, { withTools });
  // ...
}
```

### `directInit` in `init.ts`

Add `noTools?: boolean` parameter:

```typescript
export async function directInit(
  cwd: string,
  projectName: string,
  templateName: string,
  provider: string,
  apiKey: string,
  noTools = false
): Promise<void> {
  await createStudioStructure(cwd, projectName, templateName, !noTools);
  // ...
}
```

### Wizard step in `initCommand`

After model selection (Step 5b), before creating structure (Step 6):

```typescript
// Step 6: Tool selection
const availableTools = await listAvailableTools();
let selectedTools: string[] = [];

if (availableTools.length > 0) {
  const selectedTemplate = templates.find((t) => t.name === templateName);
  const recommended = new Set(selectedTemplate?.tools_included ?? []);

  const choices = availableTools.map((t) => ({
    value: t.name,
    name: `${t.name} — ${t.description}`,
    checked: recommended.has(t.name),
  }));

  selectedTools = await checkbox({
    message: 'Select tools to install:',
    choices,
  });
}

// Step 7: Create structure (without tools — we install them below)
const spinner = ora('Creating project...').start();
await createStudioStructure(cwd, projectName, templateName, false);
if (provider !== 'later' && apiKey) {
  await writeProviderToConfig(studioDir, provider, apiKey, selectedModel);
}
spinner.stop();

// Step 8: Install selected tools
if (selectedTools.length > 0) {
  await toolsAddDirect(studioDir, projectName, selectedTools);
}
```

Success output (after creation):
```typescript
if (selectedTools.length > 0) {
  console.log(chalk.green(`  ✓ Installed tools: ${selectedTools.join(', ')}`));
}
```

### CLI flag in `index.ts`

```typescript
program
  .command('init [name]')
  // ...existing options...
  .option('--no-tools', 'Skip tool installation in direct mode')
  .action(initCommand);
```

---

## Files Changed

| File | Change |
|------|--------|
| `cli/src/commands/project.ts` | `createProjectDir` + `options?: { withTools? }` |
| `cli/src/commands/init.ts` | `createStudioStructure` + `withTools`; wizard tool step; `directInit` + `noTools`; import `listAvailableTools`, `toolsAddDirect`, `checkbox` |
| `cli/src/index.ts` | `--no-tools` flag on `studio init` |
| `cli/tests/commands/project.test.ts` | `withTools: false` tests |
| `cli/tests/commands/init.test.ts` | `createStudioStructure(withTools: false)` and `directInit(noTools: true)` tests |

---

## Acceptance Criteria Mapping

| AC | Covered by |
|----|-----------|
| Wizard proposes tool selection after provider config | Wizard Step 6 (after model selection) |
| Tools proposed match template (or all if blank) | `tools_included` from metadata pre-checks; blank = all unchecked |
| Already installed tools marked as disabled | `toolsAddDirect` skips already-installed; wizard `disabled` on pre-installed ones (re-init with --force) |
| Direct mode: skip interactivity, use template defaults | `createStudioStructure(withTools: true)` copies template tools as before |
| `--no-tools` flag skips installation in direct mode | `noTools` param + `withTools: false` |
| Confirmation message includes installed tools | Success output lists `selectedTools` |
