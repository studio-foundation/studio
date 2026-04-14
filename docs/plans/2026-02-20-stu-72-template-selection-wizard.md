# STU-72: Template Selection Init Wizard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve `studio init` wizard by: (1) moving template selection to step 1, (2) showing a template details card after selection, (3) validating project name, (4) removing the dead description step, (5) adding a "install dependencies now?" step with automatic package manager detection, and (6) failing fast on non-interactive terminals.

**Architecture:** Single-file change — only the wizard section of `initCommand()` in `cli/src/commands/init.ts` is modified. One new exported function `validateProjectName()` is added (mirrors existing `validateApiKeyFormat` pattern) and tested. The private `detectPackageManager()` helper uses `spawnSync` (already imported). No new files needed.

**Tech Stack:** TypeScript, `@inquirer/prompts` (confirm), `ora`, `chalk`, `node:child_process.spawnSync`, Vitest.

---

### Current State (read before touching anything)

- `cli/src/commands/init.ts` — wizard section is lines ~499–680 inside `initCommand()`.
- Current wizard step order: project name → (dead description) → template → provider → api key → model → tools → generate → tools install → success.
- `spawnSync` is already imported from `node:child_process`.
- `confirm` is already imported from `@inquirer/prompts`.
- `DEFAULT_MODELS` (lines ~147–150) maps provider → default model string.
- Tests live in `cli/tests/commands/init.test.ts`.
- Non-interactive tests use `/tmp/.studio-init-test` as base dir (see MEMORY.md).
- Running tests: `pnpm --filter @studio-foundation/cli test` (runs vitest in run mode).
- Full build: `pnpm build` at monorepo root.

---

### Task 1: Extract and test `validateProjectName`

This adds a testable helper that encapsulates the project name rules. Mirrors `validateApiKeyFormat` which already lives in `init.ts` and is tested.

**Files:**
- Modify: `cli/src/commands/init.ts` — add `validateProjectName` export
- Modify: `cli/tests/commands/init.test.ts` — add `describe('validateProjectName')` block

**Step 1: Write the failing tests**

In `cli/tests/commands/init.test.ts`, import and add a describe block. Find where `validateApiKeyFormat` tests are and append after them:

```typescript
describe('validateProjectName', () => {
  let validateProjectName: (name: string) => true | string;

  beforeAll(async () => {
    const mod = await import('../../src/commands/init.js');
    validateProjectName = mod.validateProjectName;
  });

  it('accepts valid names', () => {
    expect(validateProjectName('my-app')).toBe(true);
    expect(validateProjectName('my_project')).toBe(true);
    expect(validateProjectName('MyApp123')).toBe(true);
    expect(validateProjectName('app.v2')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(validateProjectName('')).toBeTypeOf('string');
  });

  it('rejects names with spaces', () => {
    expect(validateProjectName('my app')).toBeTypeOf('string');
    expect(validateProjectName('my\tapp')).toBeTypeOf('string');
  });

  it('rejects names starting with a hyphen', () => {
    expect(validateProjectName('-bad')).toBeTypeOf('string');
  });

  it('rejects names with special characters', () => {
    expect(validateProjectName('my@app')).toBeTypeOf('string');
    expect(validateProjectName('app!')).toBeTypeOf('string');
    expect(validateProjectName('app/dir')).toBeTypeOf('string');
  });
});
```

**Step 2: Run to verify failure**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm --filter @studio-foundation/cli test 2>&1 | grep -A5 'validateProjectName'
```

Expected: fails with "validateProjectName is not a function" or "not exported".

**Step 3: Add `validateProjectName` to `init.ts`**

In `cli/src/commands/init.ts`, find `validateApiKeyFormat` (around line 213) and add this function right after it:

```typescript
/**
 * Validate a project name for use as a directory name.
 * Returns true if valid, or an error string to display.
 */
export function validateProjectName(name: string): true | string {
  if (!name.trim()) return 'Project name cannot be empty';
  if (/\s/.test(name)) return 'Project name cannot contain spaces';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9\-_.]*$/.test(name))
    return 'Project name must start with a letter or digit and contain only letters, digits, hyphens, underscores, or dots';
  return true;
}
```

**Step 4: Build and run tests**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm build && pnpm --filter @studio-foundation/cli test 2>&1 | grep -E '(validateProjectName|PASS|FAIL)'
```

Expected: all `validateProjectName` tests pass, all existing tests still pass.

**Step 5: Commit**

```bash
git add cli/src/commands/init.ts cli/tests/commands/init.test.ts
git commit -m "feat(cli): add validateProjectName helper (STU-72)"
```

---

### Task 2: Rewrite wizard section of `initCommand()`

This is the main change. The wizard section is self-contained (lines ~499–680 inside the `try` block of `initCommand()`). Replace the entire wizard section while keeping the direct-mode section unchanged.

**Files:**
- Modify: `cli/src/commands/init.ts` — wizard section only (lines ~499–680)

**Step 1: Understand the exact boundaries**

The wizard mode starts at this comment:
```typescript
// ── Wizard mode ───────────────────────────────────────────────────
```
And ends just before:
```typescript
  } catch (error) {
    // Graceful exit on Ctrl+C
```

Everything between those two points will be replaced.

**Step 2: Add `detectPackageManager` private helper**

Add this function near the top of the file, after the `validateProjectName` export (before `initCommand`):

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

**Step 3: Add `printTemplateCard` private helper**

Add after `detectPackageManager`:

```typescript
function printTemplateCard(template: TemplateMetadata): void {
  const lines: string[] = [template.description];
  if (template.pipelines?.length) {
    lines.push(`Pipelines: ${template.pipelines.join(', ')}`);
  }
  if (template.tools_included?.length) {
    lines.push(`Tools:     ${template.tools_included.join(', ')}`);
  }
  const innerWidth = Math.max(...lines.map((l) => l.length));
  const bar = '─'.repeat(innerWidth + 4);
  const templateLabel = `─ ${template.name} `;
  const rightBar = '─'.repeat(Math.max(0, bar.length - templateLabel.length));
  console.log('');
  console.log(`  ${templateLabel}${rightBar}`);
  for (const line of lines) {
    console.log(`  │  ${line}`);
  }
  console.log(`  ${bar}`);
  console.log('');
}
```

Note: `TemplateMetadata` is already imported via `import { listTemplates } from './templates.js'`. Check the import — if `TemplateMetadata` isn't imported directly, add it:
```typescript
import { listTemplates, type TemplateMetadata } from './templates.js';
```

**Step 4: Replace the wizard section**

Find this comment and everything after it until the `} catch (error) {` block:

```typescript
    // ── Wizard mode ───────────────────────────────────────────────────
    console.log('');
    console.log(chalk.bold('  ╭─────────────────────────────────╮'));
    ...
    console.log('');
```

Replace the entire wizard block with:

```typescript
    // ── Wizard mode ───────────────────────────────────────────────────

    // Non-interactive terminal fallback
    if (!process.stdin.isTTY) {
      console.error('stdin is not a TTY. Use flags for non-interactive init:');
      console.error('  studio init --template <type> --name <project> --provider <provider> --api-key <key>');
      process.exit(1);
    }

    console.log('');
    console.log(chalk.bold('  ╭─────────────────────────────────╮'));
    console.log(chalk.bold('  │  Studio — Create App            │'));
    console.log(chalk.bold('  ╰─────────────────────────────────╯'));
    console.log('');

    // Step 1: Template selection (first — drives everything else)
    const templates = await listTemplates();
    const templateChoices = templates.map((t) => ({
      value: t.name,
      name: `${t.name} — ${t.description}`,
    }));

    const templateName = await select({
      message: 'What type of app are you building?',
      choices: templateChoices,
    });

    // Show template details card
    const selectedTemplateMeta = templates.find((t) => t.name === templateName);
    if (selectedTemplateMeta) {
      printTemplateCard(selectedTemplateMeta);
    }

    // Step 2: Project name (with validation)
    const defaultName = nameArg ?? options.project ?? basename(cwd);
    const projectName = await input({
      message: 'Project name:',
      default: defaultName,
      validate: validateProjectName,
    });

    // Step 3: Provider
    const provider = await select<string>({
      message: 'LLM Provider:',
      choices: [
        { value: 'anthropic', name: 'Anthropic (Claude)' },
        { value: 'openai', name: 'OpenAI (GPT)' },
        { value: 'later', name: 'Configure later' },
      ],
    });

    // Step 4: API Key
    let apiKey: string | undefined;
    if (provider !== 'later') {
      const providerLabel = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
      while (true) {
        apiKey = await password({
          message: `${providerLabel} API Key:`,
          validate: (value: string) => validateApiKeyFormat(provider, value),
        });
        const spinner = ora('Validating...').start();
        const result = await validateApiKeyLive(provider, apiKey);
        spinner.stop();
        if (result.status === 'valid') {
          console.log(chalk.green('  ✓ Valid'));
          break;
        } else if (result.status === 'warning') {
          console.log(chalk.yellow(`  ⚠ ${result.message}`));
          break;
        } else {
          console.log(chalk.red(`  ✗ ${result.error}`));
          console.log(chalk.gray('  Please try again.'));
        }
      }
    }

    // Step 5: Choose default model
    let selectedModel: string | undefined;
    if (provider !== 'later' && apiKey) {
      const models = await getAvailableModels(provider, apiKey);
      const fallback = DEFAULT_MODELS[provider] ?? 'claude-sonnet-4-20250514';

      if (models.length > 0) {
        const choices = [
          ...models.map((m) => ({ value: m, name: m })),
          { value: '__custom__', name: 'Enter custom model ID' },
        ];
        const chosen = await select<string>({
          message: 'Default model:',
          choices,
          default: models.includes(fallback) ? fallback : models[0],
        });
        if (chosen === '__custom__') {
          selectedModel = await input({ message: 'Model ID:', default: fallback });
        } else {
          selectedModel = chosen;
        }
      } else {
        selectedModel = await input({ message: 'Default model:', default: fallback });
      }
    }

    // Step 6: Tool selection
    const availableTools = await listAvailableTools();
    let selectedTools: string[] = [];

    if (availableTools.length > 0) {
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

    // Step 7: Install dependencies preference
    const pkgManager = detectPackageManager();
    const installNow = await confirm({
      message: `Install dependencies now? (uses ${pkgManager})`,
      default: false,
    });

    // Step 8: Generate app (without tools — we install them below)
    console.log('');
    const spinner = ora('Creating project...').start();

    const studioDir = resolve(cwd, '.studio');

    let gitInitialized = false;
    try {
      ({ gitInitialized } = await generateFullApp(cwd, projectName, templateName, { noTools: true }));

      if (provider !== 'later' && apiKey) {
        await writeProviderToConfig(studioDir, provider, apiKey, selectedModel);
      }

      spinner.stop();
    } catch (err) {
      spinner.fail('Failed');
      throw err;
    }

    // Step 9: Install selected tools
    if (selectedTools.length > 0) {
      await toolsAddDirect(studioDir, 'default', selectedTools);
    }

    // Step 10: Install dependencies (if requested)
    if (installNow) {
      const installSpinner = ora(`Running ${pkgManager} install...`).start();
      const installResult = spawnSync(pkgManager, ['install'], { cwd, encoding: 'utf-8' });
      if (installResult.status === 0) {
        installSpinner.succeed('Dependencies installed');
      } else {
        installSpinner.warn(`Install failed — run \`${pkgManager} install\` manually`);
      }
    }

    // Step 11: Success output
    console.log(chalk.green(`  ✓ .studio/config.yaml`));
    console.log(chalk.green(`  ✓ .studio/pipelines/`));
    console.log(chalk.green(`  ✓ src/`));
    console.log(chalk.green(`  ✓ prisma/schema.prisma`));
    console.log(chalk.green(`  ✓ package.json`));
    console.log(chalk.green(`  ✓ README.md`));
    if (gitInitialized) {
      console.log(chalk.green(`  ✓ git initialized`));
    }
    console.log(chalk.green(`  ✓ Updated .gitignore`));
    if (selectedTools.length > 0) {
      console.log(chalk.green(`  ✓ Installed tools: ${selectedTools.join(', ')}`));
    }
    console.log('');

    // Step 12: Next steps
    const firstPipeline = selectedTemplateMeta?.pipelines?.[0] ?? 'your-pipeline';

    console.log(chalk.bold('Done! Next steps:'));
    if (!installNow) {
      console.log(`  ${chalk.cyan(`${pkgManager} install`)}`);
    }
    console.log(
      `  ${chalk.cyan(`studio run ${firstPipeline} --input "..."`)}`
    );
    if (provider === 'later') {
      console.log('');
      console.log('Set your API key first:');
      console.log(
        `  ${chalk.cyan('studio config set provider anthropic --api-key $ANTHROPIC_API_KEY')}`
      );
    }
    console.log('');
```

**Step 5: Build and verify TypeScript compiles**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm build 2>&1
```

Expected: exits 0, no TypeScript errors.

**Step 6: Run the full test suite**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm --filter @studio-foundation/cli test 2>&1
```

Expected: all tests pass. The wizard change doesn't affect any existing unit tests (they test `createStudioStructure`, `directInit`, `generateFullApp`, etc. — none of which involve interactive prompts).

**Step 7: Smoke test the wizard manually**

```bash
cd /tmp
mkdir stu72-test && cd stu72-test
node /home/arianeguay/dev/src/Studio/cli/dist/index.js init
```

Walk through the wizard:
- Verify template selection is the FIRST prompt
- Select `software` and confirm the details card is printed
- Enter a valid project name → should accept
- Try a name with a space → should reject with error message
- Complete the wizard through provider / api key / model / tools
- Answer "No" to "Install dependencies now?" → verify `npm/pnpm install` appears in "Next steps"
- Answer "Yes" and re-run → verify spinner runs and next steps no longer show the install command

```bash
# Check output structure
ls -la /tmp/stu72-test/
cat /tmp/stu72-test/package.json  # should have correct project name
ls /tmp/stu72-test/.studio/

# Cleanup
rm -rf /tmp/stu72-test
```

**Step 8: Test non-interactive fallback**

```bash
cd /tmp
echo "" | node /home/arianeguay/dev/src/Studio/cli/dist/index.js init
```

Expected output contains:
```
stdin is not a TTY. Use flags for non-interactive init:
  studio init --template <type> --name <project> --provider <provider> --api-key <key>
```
Expected exit code: 1.

**Step 9: Commit**

```bash
cd /home/arianeguay/dev/src/Studio
git add cli/src/commands/init.ts
git commit -m "feat(cli): add template selection as first wizard step (STU-72)"
```

---

### Task 3: Final verification

**Step 1: Run full monorepo test suite**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm test 2>&1
```

Expected: all tests across all packages pass. Zero failures.

**Step 2: Build check**

```bash
pnpm build 2>&1
```

Expected: exits 0.

**Step 3: Verify acceptance criteria**

- [ ] Interactive wizard for `studio init` (no args) — already existed, still works
- [ ] Template selection as FIRST step — verified in smoke test
- [ ] Lists all templates with descriptions — verified in smoke test
- [ ] Shows what each template includes (details card) — verified in smoke test
- [ ] Validates project name (no spaces, not empty) — verified via unit tests + smoke test
- [ ] Validates API key format — unchanged, still works
- [ ] Optional install dependencies (detect package manager) — verified in smoke test (both yes/no paths)
- [ ] Clear success message with next steps — verified in smoke test
- [ ] Falls back to manual mode if non-interactive terminal — verified in Step 8

**Step 4: Mark STU-72 as Done in Linear**

Use the Linear MCP tool to update issue `STU-72` status to Done.

---

### Notes for executor

- **`TemplateMetadata` import:** The type is exported from `templates.ts`. Confirm the import at the top of `init.ts` reads `import { listTemplates, type TemplateMetadata } from './templates.js'`. If it only imports `listTemplates`, add `type TemplateMetadata` to the import.
- **`spawnSync` is already imported** in `init.ts` (used by `initGitRepo`). Do not add a duplicate import.
- **`confirm` is already imported** from `@inquirer/prompts` (used by the `--force` backup confirmation). Do not add a duplicate import.
- **`selectedTemplateMeta` shadowing:** The direct mode section (lines ~480–497) also calls `listTemplates()` and uses `selectedTemplate`. Those are in a separate scope; no conflict.
- **Dead description step:** Lines ~513–515 (`await input({ message: 'Description...' })`) are entirely removed. The `input` function is still imported and used for project name and model ID.
- **The `templates` variable:** In the old wizard, `templates` was loaded at Step 3. In the new wizard it's loaded at Step 1. The old reference in "Step 10" (`const selectedTemplate = templates.find(...)`) is replaced by `selectedTemplateMeta` (already resolved at Step 1). No duplicate lookup needed.
