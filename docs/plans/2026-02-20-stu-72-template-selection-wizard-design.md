# STU-72: Template Selection Init Wizard — Design

**Issue:** [STU-72 — Add template selection to init wizard](https://linear.app/studioag/issue/STU-72/add-template-selection-to-init-wizard)

**Depends on:** STU-71 (Done) — `generateFullApp()`, `generateAppFiles()`, `initGitRepo()` all exist in `init.ts`.

---

## Problem

The existing `studio init` wizard has template selection buried at step 3 (after project name and a dead description step). It lacks project name validation, has no way to show template details after selection, no "install dependencies" option, and no fallback for non-interactive terminals.

---

## Approach

Approach A — minimal reshuffle of the wizard section in `initCommand()`. Only `cli/src/commands/init.ts` changes. No new files. All existing functionality preserved.

---

## Wizard UX Flow (new order)

```
[Non-TTY check at wizard entry — exit with usage if stdin is not a TTY]

╭─────────────────────────────────╮
│  Studio — Create App            │
╰─────────────────────────────────╯

Step 1: "What type of app are you building?"
  → select from listTemplates() (name — description)

Step 2: Template details card (printed after selection):
  ─ software ─────────────────────────────────────────────
  │  Code generation with repo, shell and search tools    │
  │  Pipelines: feature-builder, quick-edit               │
  │  Tools:     repo-manager, search, shell               │
  ─────────────────────────────────────────────────────────
  (lines omitted if metadata lacks pipelines/tools_included)

Step 3: "Project name:"  → validated (see below)

[Step REMOVED: dead description step — deleted]

Step 4: "LLM Provider:"  (unchanged)

Step 5: "API Key:"        (unchanged — format + live validation)

Step 6: "Default model:" (unchanged)

Step 7: "Select tools to install:" (checkbox, unchanged)

Step 8: "Install dependencies now?" → Yes / No
  → if Yes: detect package manager, show in prompt label, run in spinner

Step 9: Generate app (generateFullApp + writeProviderToConfig)

Step 10: Install selected tools (toolsAddDirect, unchanged)

Step 11: Optional dep install (if Step 8 = Yes)

Step 12: Success output + next steps
```

---

## Technical Specifications

### Project Name Validation

Validate in the `input()` prompt's `validate` callback:

```typescript
validate: (value: string) => {
  if (!value.trim()) return 'Project name cannot be empty';
  if (/\s/.test(value)) return 'Project name cannot contain spaces';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9\-_.]*$/.test(value))
    return 'Project name must be a valid directory name (letters, digits, hyphens, underscores, dots)';
  return true;
}
```

### Non-TTY Fallback

At the top of wizard mode (before any prompts):

```typescript
if (!process.stdin.isTTY) {
  console.error('stdin is not a TTY. Use flags for non-interactive init:');
  console.error('  studio init --template <type> --name <project> --provider <provider> --api-key <key>');
  process.exit(1);
}
```

### Template Details Card

After `templateName` is resolved from the `select()`:

```typescript
const selectedTemplateMeta = templates.find((t) => t.name === templateName);
if (selectedTemplateMeta) {
  const lines: string[] = [selectedTemplateMeta.description];
  if (selectedTemplateMeta.pipelines?.length) {
    lines.push(`Pipelines: ${selectedTemplateMeta.pipelines.join(', ')}`);
  }
  if (selectedTemplateMeta.tools_included?.length) {
    lines.push(`Tools:     ${selectedTemplateMeta.tools_included.join(', ')}`);
  }
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const bar = '─'.repeat(width);
  console.log('');
  console.log(`  ─ ${templateName} ${bar.slice(templateName.length + 3)}`);
  for (const line of lines) console.log(`  │  ${line}`);
  console.log(`  ${'─'.repeat(width + 2)}`);
  console.log('');
}
```

### Package Manager Detection

```typescript
function detectPackageManager(): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  const check = (cmd: string) =>
    spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
  if (check('pnpm')) return 'pnpm';
  if (check('yarn')) return 'yarn';
  if (check('bun')) return 'bun';
  return 'npm';
}
```

The confirm prompt shows which tool will run:

```typescript
const pkgManager = detectPackageManager();
const installNow = await confirm({
  message: `Install dependencies now? (uses ${pkgManager})`,
  default: false,
});
```

If confirmed, run in spinner after app generation:

```typescript
if (installNow) {
  const installSpinner = ora(`Running ${pkgManager} install...`).start();
  const result = spawnSync(pkgManager, ['install'], { cwd, encoding: 'utf-8' });
  if (result.status === 0) {
    installSpinner.succeed(`Dependencies installed`);
  } else {
    installSpinner.warn(`Install failed — run \`${pkgManager} install\` manually`);
  }
}
```

---

## Files Changed

- **Modified:** `cli/src/commands/init.ts` — only the wizard section of `initCommand()` (~lines 499–680)

No new files, no new exports, no new tests required (existing tests don't test interactive prompts).

---

## Acceptance Criteria

- [x] Interactive wizard for `studio init` (no args) — already existed
- [ ] Template selection as first step (reorder)
- [ ] Lists all templates with descriptions — already existed, now first
- [ ] Shows what each template includes (details card)
- [ ] Validates project name (no spaces, not empty)
- [ ] Validates API key format — already existed
- [ ] Optional install dependencies after generation (detect package manager)
- [ ] Clear success message with next steps — already existed
- [ ] Falls back to manual mode if non-interactive terminal
