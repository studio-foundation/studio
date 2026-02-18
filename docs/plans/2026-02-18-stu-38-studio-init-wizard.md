# STU-38 — `studio init` Wizard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current non-interactive `studio init` with a step-by-step wizard that collects project name, template, provider, and API key, then creates a complete `.studio/` structure.

**Architecture:** Wizard lives entirely in `cli/src/commands/init.ts`. `createStudioStructure()` is untouched. After structure creation, a new `writeProviderToConfig()` helper updates `config.yaml` with the chosen provider via `js-yaml`. Two new helpers (`validateApiKeyFormat`, `writeProviderToConfig`) are exported for testability.

**Tech Stack:** `@inquirer/prompts` (new dep — `input`, `select`, `password`), `ora` (already installed), `chalk` (already installed), `js-yaml` (already installed)

---

## Task 1: Add `@inquirer/prompts` dependency

**Files:**
- Modify: `cli/package.json`

**Step 1: Install the package**

```bash
cd /path/to/Studio
pnpm add @inquirer/prompts --filter @studio/cli
```

Expected: package added to `cli/package.json` under `dependencies`, `pnpm-lock.yaml` updated.

**Step 2: Verify the install**

```bash
node -e "const {input,select,password} = await import('@inquirer/prompts'); console.log('ok')" --input-type=module
```

Expected: prints `ok` (no import error).

**Step 3: Commit**

```bash
git add cli/package.json pnpm-lock.yaml
git commit -m "feat(cli): add @inquirer/prompts dependency"
```

---

## Task 2: Test + implement `validateApiKeyFormat`

**Files:**
- Modify: `cli/src/commands/init.ts` (add + export the helper)
- Modify: `cli/tests/commands/init.test.ts` (add tests)

### Step 1: Write the failing tests

Add at the **bottom** of `cli/tests/commands/init.test.ts`:

```typescript
describe('validateApiKeyFormat', () => {
  it('accepts a valid Anthropic key', async () => {
    const { validateApiKeyFormat } = await import('../../src/commands/init.js');
    expect(validateApiKeyFormat('anthropic', 'sk-ant-api03-abc123')).toBe(true);
  });

  it('rejects an Anthropic key with wrong prefix', async () => {
    const { validateApiKeyFormat } = await import('../../src/commands/init.js');
    const result = validateApiKeyFormat('anthropic', 'sk-wrong-key');
    expect(typeof result).toBe('string'); // returns error message
    expect(result).toContain('sk-ant-');
  });

  it('accepts a valid OpenAI key', async () => {
    const { validateApiKeyFormat } = await import('../../src/commands/init.js');
    expect(validateApiKeyFormat('openai', 'sk-proj-abc123')).toBe(true);
  });

  it('rejects an OpenAI key with wrong prefix', async () => {
    const { validateApiKeyFormat } = await import('../../src/commands/init.js');
    const result = validateApiKeyFormat('openai', 'wrong-key');
    expect(typeof result).toBe('string');
    expect(result).toContain('sk-');
  });

  it('accepts any key for unknown provider', async () => {
    const { validateApiKeyFormat } = await import('../../src/commands/init.js');
    expect(validateApiKeyFormat('later', '')).toBe(true);
  });
});
```

### Step 2: Run to verify they fail

```bash
pnpm --filter @studio/cli test
```

Expected: FAIL with `validateApiKeyFormat is not a function` or similar.

### Step 3: Implement the function

Add to `cli/src/commands/init.ts`, **above** `initCommand`, and add to the exports:

```typescript
/**
 * Validate API key format without making a network call.
 * Returns true if valid, or an error string to display.
 */
export function validateApiKeyFormat(provider: string, key: string): true | string {
  if (provider === 'anthropic') {
    if (!key.startsWith('sk-ant-')) {
      return 'Anthropic API keys must start with sk-ant-';
    }
  } else if (provider === 'openai') {
    if (!key.startsWith('sk-')) {
      return 'OpenAI API keys must start with sk-';
    }
  }
  return true;
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter @studio/cli test
```

Expected: all tests PASS including the new `validateApiKeyFormat` suite.

### Step 5: Commit

```bash
git add cli/src/commands/init.ts cli/tests/commands/init.test.ts
git commit -m "feat(cli): STU-38 — add validateApiKeyFormat helper"
```

---

## Task 3: Test + implement `writeProviderToConfig`

**Files:**
- Modify: `cli/src/commands/init.ts` (add + export the helper)
- Modify: `cli/tests/commands/init.test.ts` (add tests)

### Step 1: Write the failing tests

Add to `cli/tests/commands/init.test.ts` (requires its own tmp dir — reuse the existing `TMP` constant and `beforeEach`/`afterEach` since they already clean up):

```typescript
describe('writeProviderToConfig', () => {
  // We need a fresh .studio/ for each test — reuse the outer TMP/beforeEach/afterEach.

  it('writes anthropic key and defaults to config.yaml', async () => {
    const { createStudioStructure, writeProviderToConfig } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    const studioDir = resolve(TMP, '.studio');
    await writeProviderToConfig(studioDir, 'anthropic', 'sk-ant-test-key');

    const raw = await readFile(resolve(studioDir, 'config.yaml'), 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;

    const providers = parsed.providers as Record<string, { apiKey: string }>;
    expect(providers.anthropic.apiKey).toBe('sk-ant-test-key');

    const defaults = parsed.defaults as { provider: string; model: string };
    expect(defaults.provider).toBe('anthropic');
    expect(defaults.model).toBe('claude-sonnet-4-20250514');
  });

  it('writes openai key and defaults to config.yaml', async () => {
    const { createStudioStructure, writeProviderToConfig } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    const studioDir = resolve(TMP, '.studio');
    await writeProviderToConfig(studioDir, 'openai', 'sk-openai-test-key');

    const raw = await readFile(resolve(studioDir, 'config.yaml'), 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;

    const providers = parsed.providers as Record<string, { apiKey: string }>;
    expect(providers.openai.apiKey).toBe('sk-openai-test-key');

    const defaults = parsed.defaults as { provider: string; model: string };
    expect(defaults.provider).toBe('openai');
    expect(defaults.model).toBe('gpt-4o');
  });

  it('is idempotent — writing twice does not duplicate keys', async () => {
    const { createStudioStructure, writeProviderToConfig } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    const studioDir = resolve(TMP, '.studio');
    await writeProviderToConfig(studioDir, 'anthropic', 'sk-ant-first');
    await writeProviderToConfig(studioDir, 'anthropic', 'sk-ant-second');

    const raw = await readFile(resolve(studioDir, 'config.yaml'), 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, { apiKey: string }>;
    expect(providers.anthropic.apiKey).toBe('sk-ant-second');
  });
});
```

Add `import * as yaml from 'js-yaml';` at the top of the test file (after the existing imports).

### Step 2: Run to verify they fail

```bash
pnpm --filter @studio/cli test
```

Expected: FAIL with `writeProviderToConfig is not a function`.

### Step 3: Implement the function

Add to `cli/src/commands/init.ts`, **below** `validateApiKeyFormat`, **above** `initCommand`:

```typescript
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
};

/**
 * Write provider credentials and defaults into .studio/config.yaml.
 * Parses the existing config, sets the provider key, then rewrites.
 * Comments from the original template are lost — accepted for Phase 1.
 */
export async function writeProviderToConfig(
  studioDir: string,
  provider: string,
  apiKey: string
): Promise<void> {
  const configPath = join(studioDir, 'config.yaml');

  let raw = '';
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch {
    // Config doesn't exist yet — start from empty
  }

  const parsed = ((yaml.load(raw) ?? {}) as Record<string, unknown>);

  // Set provider key
  if (!parsed.providers || typeof parsed.providers !== 'object') {
    parsed.providers = {};
  }
  (parsed.providers as Record<string, unknown>)[provider] = { apiKey };

  // Set defaults
  parsed.defaults = {
    provider,
    model: DEFAULT_MODELS[provider] ?? 'claude-sonnet-4-20250514',
  };

  await writeFile(configPath, yaml.dump(parsed), 'utf-8');
}
```

Make sure `yaml` is imported — it already is in `init.ts` as a side-effect via `config.ts`... actually check: `init.ts` currently does NOT import `js-yaml`. Add this import at the top:

```typescript
import * as yaml from 'js-yaml';
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter @studio/cli test
```

Expected: all tests PASS.

### Step 5: Commit

```bash
git add cli/src/commands/init.ts cli/tests/commands/init.test.ts
git commit -m "feat(cli): STU-38 — add writeProviderToConfig helper"
```

---

## Task 4: Rewrite `initCommand` as interactive wizard

**Files:**
- Modify: `cli/src/commands/init.ts` (replace `initCommand`, update imports)

This is the main wizard. No unit tests for the interactive flow (can't mock prompts easily) — the helper tests from Tasks 2–3 cover the logic. Manual smoke test at end.

### Step 1: Update imports at top of `cli/src/commands/init.ts`

Replace the existing import block at the top with:

```typescript
import { mkdir, writeFile, readFile, access, cp } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import * as yaml from 'js-yaml';
import chalk from 'chalk';
import ora from 'ora';
import { input, select, password } from '@inquirer/prompts';
import { findStudioDir } from '../studio-dir.js';
import { listTemplates } from './templates.js';
```

(Note: `basename` is added to the `path` import. `ora` is moved from wherever it currently is. `@inquirer/prompts` is new.)

### Step 2: Replace `initCommand` with the wizard

Delete the existing `initCommand` function entirely and replace with:

```typescript
interface InitOptions {
  template?: string;
  project?: string;
}

export async function initCommand(_options: InitOptions = {}): Promise<void> {
  try {
    const cwd = process.cwd();

    // ── Header ──────────────────────────────────────────────
    console.log('');
    console.log(chalk.bold('  ╭─────────────────────────────────╮'));
    console.log(chalk.bold('  │  Studio — Pipeline Creator      │'));
    console.log(chalk.bold('  ╰─────────────────────────────────╯'));
    console.log('');

    // ── Step 1: Project name ────────────────────────────────
    const defaultName = basename(cwd);
    const rawName = await input({
      message: 'Project name:',
      default: defaultName,
    });
    const projectName = rawName.trim() || defaultName;

    // ── Step 2: Description (optional, not persisted) ───────
    await input({
      message: 'Description (optional, press Enter to skip):',
    });

    // ── Step 3: Template ─────────────────────────────────────
    const templates = await listTemplates();
    const templateChoices = templates.map((t) => ({
      value: t.name,
      name: `${t.name} — ${t.description}`,
    }));

    const templateName = await select({
      message: 'Choose a starter template:',
      choices: templateChoices,
    });

    // ── Step 4: Provider ─────────────────────────────────────
    const provider = await select<string>({
      message: 'LLM Provider:',
      choices: [
        { value: 'anthropic', name: 'Anthropic (Claude)' },
        { value: 'openai', name: 'OpenAI (GPT)' },
        { value: 'later', name: 'Configure later' },
      ],
    });

    // ── Step 5: API Key (skipped if "configure later") ───────
    let apiKey: string | undefined;
    if (provider !== 'later') {
      const providerLabel = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
      apiKey = await password({
        message: `${providerLabel} API Key:`,
        validate: (value: string) => validateApiKeyFormat(provider, value),
      });
    }

    // ── Step 6: Create structure ──────────────────────────────
    console.log('');
    const spinner = ora('Creating project...').start();

    const studioDir = resolve(cwd, '.studio');

    try {
      await createStudioStructure(cwd, projectName, templateName);

      if (provider !== 'later' && apiKey) {
        await writeProviderToConfig(studioDir, provider, apiKey);
      }

      spinner.stop();
    } catch (err) {
      spinner.fail('Failed');
      throw err;
    }

    // ── Step 7: Success output ────────────────────────────────
    console.log(chalk.green(`  ✓ .studio/config.yaml`));
    console.log(chalk.green(`  ✓ .studio/projects/${projectName}/`));
    console.log(chalk.green(`  ✓ Copied template files`));
    console.log(chalk.green(`  ✓ Updated .gitignore`));
    console.log('');

    // ── Step 8: Next steps ────────────────────────────────────
    const selectedTemplate = templates.find((t) => t.name === templateName);
    const firstPipeline = selectedTemplate?.pipelines?.[0] ?? 'your-pipeline';

    console.log(chalk.bold('Done! Run your first pipeline:'));
    console.log(
      `  ${chalk.cyan(`studio run ${projectName}/${firstPipeline} --input "..."`)}`
    );
    if (provider === 'later') {
      console.log('');
      console.log('Set your API key first:');
      console.log(
        `  ${chalk.cyan('studio config set provider anthropic --api-key $ANTHROPIC_API_KEY')}`
      );
    }
    console.log('');
  } catch (error) {
    // Graceful exit on Ctrl+C
    if (error instanceof Error && error.name === 'ExitPromptError') {
      console.log('\nAborted.');
      process.exit(0);
    }
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
```

### Step 3: Build

```bash
pnpm build
```

Expected: no TypeScript errors.

### Step 4: Run existing tests

```bash
pnpm --filter @studio/cli test
```

Expected: all tests PASS (existing `createStudioStructure` tests are unaffected).

### Step 5: Commit

```bash
git add cli/src/commands/init.ts
git commit -m "feat(cli): STU-38 — interactive wizard for studio init"
```

---

## Task 5: Smoke test manually

**Step 1: Create a temp dir**

```bash
mkdir /tmp/test-studio-init && cd /tmp/test-studio-init
```

**Step 2: Run the wizard**

```bash
node /path/to/Studio/cli/dist/index.js init
```

Answer the prompts:
- Project name: `my-test` (or Enter for folder default)
- Description: Enter to skip
- Template: choose `software`
- Provider: choose `Anthropic (Claude)`
- API key: `sk-ant-test123` (format-valid fake key)

**Step 3: Verify output**

```bash
ls .studio/
# → config.yaml  projects/  registry.lock.json  runs/

ls .studio/projects/my-test/
# → agents/  contracts/  inputs/  pipelines/  tools/

cat .studio/config.yaml
# → providers.anthropic.apiKey: sk-ant-test123
# → defaults.provider: anthropic
# → defaults.model: claude-sonnet-4-20250514

cat .gitignore
# → .studio/config.yaml
# → .studio/runs/
```

**Step 4: Test "configure later" path**

```bash
rm -rf /tmp/test-studio-init && mkdir /tmp/test-studio-init && cd /tmp/test-studio-init
node /path/to/Studio/cli/dist/index.js init
```

Choose provider: `Configure later`

Verify `config.yaml` keeps the env-var references from the template (not overwritten).

**Step 5: Test Ctrl+C exits cleanly**

Run `studio init`, press Ctrl+C after any prompt.
Expected: prints `\nAborted.` and exits 0 (no stack trace).

---

## Task 6: Full test suite + push

**Step 1: Full build + test from root**

```bash
cd /path/to/Studio
pnpm build && pnpm test
```

Expected: all packages build and all tests pass.

**Step 2: Push to feature branch**

```bash
git checkout -b feat/stu-38-studio-init-wizard   # if not already on branch
git push -u origin feat/stu-38-studio-init-wizard
```

**Step 3: Open PR**

```bash
gh pr create \
  --title "feat(cli): STU-38 — studio init wizard (Phase 1)" \
  --body "$(cat <<'EOF'
## Summary
- Replaces non-interactive `studio init` with a step-by-step wizard using `@inquirer/prompts`
- Wizard collects: project name, description (wizard-only), template, provider, API key
- API key validated by format only (`/^sk-ant-/` for Anthropic, `/^sk-/` for OpenAI)
- Writes provider + model defaults to `config.yaml` after structure creation
- Ctrl+C exits cleanly with "Aborted." message

## Packages touched
- `@studio/cli` only

## How to test
1. `pnpm build`
2. `node cli/dist/index.js init` in an empty directory
3. Walk through the wizard
4. Verify `.studio/` structure and `config.yaml` contents

## Acceptance criteria (from STU-38)
- [x] wizard launches on `studio init`
- [x] questions: name, description, template, provider, API key
- [x] format validation on API key
- [x] `.studio/config.yaml` written with provider
- [x] `.studio/projects/<name>/` created with full structure
- [x] template files copied
- [x] `.gitignore` entries added automatically
- [x] next steps message shown

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
