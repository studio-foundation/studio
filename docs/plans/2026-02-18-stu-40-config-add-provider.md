# STU-40 — `studio config add-provider` Wizard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `studio config add-provider` — an interactive wizard (and direct mode) to add an LLM provider to `.studio/config.yaml` after initial `studio init`.

**Architecture:** Add two exported helpers (`PROVIDERS`, `validateApiKeyForProvider`, `addProviderConfig`) to `cli/src/commands/config.ts`, plus a private wizard function `configAddProviderWizard`. Wire a new `'add-provider'` case into the existing `configCommand` switch. Add `--set-default` flag to the CLI in `index.ts`.

**Tech Stack:** TypeScript, @inquirer/prompts (`select`, `password`, `confirm`), js-yaml, chalk, vitest.

---

## Key Context

- **Relevant files:**
  - `cli/src/commands/config.ts` — main file to modify (add helpers + new case)
  - `cli/src/index.ts` — add `--set-default` flag to `config` command
  - `cli/tests/commands/config.test.ts` — existing test file to extend
  - `cli/src/commands/init.ts` — reference for `validateApiKeyFormat` and `writeProviderToConfig` patterns

- **Existing reusable infrastructure in `config.ts`:**
  - `resolveConfigFilePath()` — finds/creates `.studio/config.yaml` (private)
  - `loadRawConfig(configFile)` — reads and parses YAML (private)
  - `saveConfig(configFile, config)` — writes YAML (private)

- **Do NOT reuse `writeProviderToConfig` from `init.ts`** — it always sets defaults and only handles 2 providers. We write a new, more flexible `addProviderConfig`.

- **Wizards use:** `select`, `password`, `confirm` from `@inquirer/prompts`. `password` is already imported in `init.ts`; must add it to the imports of `config.ts`.

- **Test base directory:** Use `/tmp` for any tests that might call `loadConfig()` or `findStudioDir()`. But `addProviderConfig` takes a direct `configFile` path — no `findStudioDir` involved — so `import.meta.dirname` is fine.

---

## Task 1: Add `PROVIDERS` constant and `validateApiKeyForProvider` to `config.ts`

**Files:**
- Modify: `cli/src/commands/config.ts`
- Test: `cli/tests/commands/config.test.ts`

### Step 1: Write the failing tests

Add to `cli/tests/commands/config.test.ts`:

```typescript
import { PROVIDERS, validateApiKeyForProvider } from '../../src/commands/config.js';

describe('PROVIDERS', () => {
  it('includes anthropic, openai, google, local', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('google');
    expect(ids).toContain('local');
  });

  it('each provider has id, label, and defaultModel', () => {
    for (const p of PROVIDERS) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.label).toBe('string');
      expect(typeof p.defaultModel).toBe('string');
    }
  });
});

describe('validateApiKeyForProvider', () => {
  it('accepts a valid Anthropic key (sk-ant-...)', () => {
    expect(validateApiKeyForProvider('anthropic', 'sk-ant-api03-abc123')).toBe(true);
  });

  it('rejects an Anthropic key with wrong prefix', () => {
    const result = validateApiKeyForProvider('anthropic', 'sk-wrong');
    expect(typeof result).toBe('string');
    expect(result).toContain('sk-ant-');
  });

  it('accepts a valid OpenAI key (sk-...)', () => {
    expect(validateApiKeyForProvider('openai', 'sk-proj-abc123')).toBe(true);
  });

  it('rejects an OpenAI key with wrong prefix', () => {
    const result = validateApiKeyForProvider('openai', 'wrong-key');
    expect(typeof result).toBe('string');
    expect(result).toContain('sk-');
  });

  it('accepts a valid Google key (AIza...)', () => {
    expect(validateApiKeyForProvider('google', 'AIzaSyABC123')).toBe(true);
  });

  it('rejects a Google key with wrong prefix', () => {
    const result = validateApiKeyForProvider('google', 'wrong-key');
    expect(typeof result).toBe('string');
    expect(result).toContain('AIza');
  });

  it('accepts any value for local provider (no validation)', () => {
    expect(validateApiKeyForProvider('local', 'http://localhost:11434')).toBe(true);
    expect(validateApiKeyForProvider('local', '')).toBe(true);
  });

  it('accepts any value for unknown providers', () => {
    expect(validateApiKeyForProvider('future-provider', 'any-key')).toBe(true);
  });
});
```

### Step 2: Run to verify tests fail

```bash
cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test 2>&1 | tail -20
```

Expected: FAIL — `PROVIDERS` and `validateApiKeyForProvider` not exported yet.

### Step 3: Add `PROVIDERS` and `validateApiKeyForProvider` to `config.ts`

Add after the existing imports in `cli/src/commands/config.ts`:

```typescript
export const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic (Claude)', defaultModel: 'claude-sonnet-4-20250514' },
  { id: 'openai',    label: 'OpenAI (GPT)',        defaultModel: 'gpt-4o' },
  { id: 'google',    label: 'Google (Gemini)',     defaultModel: 'gemini-1.5-pro' },
  { id: 'local',     label: 'Local (Ollama)',      defaultModel: 'llama3.2' },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]['id'];

export function validateApiKeyForProvider(provider: string, key: string): true | string {
  if (provider === 'anthropic') {
    if (!key.startsWith('sk-ant-')) return 'Anthropic API keys must start with sk-ant-';
  } else if (provider === 'openai') {
    if (!key.startsWith('sk-')) return 'OpenAI API keys must start with sk-';
  } else if (provider === 'google') {
    if (!key.startsWith('AIza')) return 'Google API keys must start with AIza';
  }
  // local / unknown providers: no format constraint
  return true;
}
```

### Step 4: Run tests to verify they pass

```bash
cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test 2>&1 | tail -20
```

Expected: All new tests PASS, existing tests still PASS.

### Step 5: Commit

```bash
git add cli/src/commands/config.ts cli/tests/commands/config.test.ts
git commit -m "feat(cli): STU-40 — add PROVIDERS list and validateApiKeyForProvider"
```

---

## Task 2: Add `addProviderConfig` helper

**Files:**
- Modify: `cli/src/commands/config.ts`
- Test: `cli/tests/commands/config.test.ts`

### Step 1: Write the failing tests

Add to `cli/tests/commands/config.test.ts` (inside the existing TMP/STUDIO_DIR setup):

```typescript
import { addProviderConfig } from '../../src/commands/config.js';
import { readFile, writeFile } from 'node:fs/promises';
import * as yaml from 'js-yaml';

// Uses existing TMP = resolve(import.meta.dirname, '.tmp-config-cmd-test')
// and STUDIO_DIR = resolve(TMP, '.studio')
// with beforeEach mkdir / afterEach rm already in place

const CONFIG_FILE = resolve(STUDIO_DIR, 'config.yaml');

describe('addProviderConfig', () => {
  it('writes provider apiKey to config.yaml', async () => {
    await addProviderConfig(CONFIG_FILE, 'anthropic', 'sk-ant-key', false);

    const raw = await readFile(CONFIG_FILE, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, { apiKey: string }>;
    expect(providers.anthropic.apiKey).toBe('sk-ant-key');
  });

  it('sets defaults when setDefault=true', async () => {
    await addProviderConfig(CONFIG_FILE, 'anthropic', 'sk-ant-key', true);

    const raw = await readFile(CONFIG_FILE, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const defaults = parsed.defaults as { provider: string; model: string };
    expect(defaults.provider).toBe('anthropic');
    expect(defaults.model).toBe('claude-sonnet-4-20250514');
  });

  it('does not touch defaults when setDefault=false', async () => {
    await addProviderConfig(CONFIG_FILE, 'anthropic', 'sk-ant-key', false);

    const raw = await readFile(CONFIG_FILE, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    expect(parsed.defaults).toBeUndefined();
  });

  it('preserves existing provider when adding a second', async () => {
    await addProviderConfig(CONFIG_FILE, 'anthropic', 'sk-ant-key', false);
    await addProviderConfig(CONFIG_FILE, 'openai', 'sk-openai-key', false);

    const raw = await readFile(CONFIG_FILE, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, { apiKey: string }>;
    expect(providers.anthropic.apiKey).toBe('sk-ant-key');
    expect(providers.openai.apiKey).toBe('sk-openai-key');
  });

  it('overwrites existing provider key', async () => {
    await addProviderConfig(CONFIG_FILE, 'anthropic', 'sk-ant-first', false);
    await addProviderConfig(CONFIG_FILE, 'anthropic', 'sk-ant-second', false);

    const raw = await readFile(CONFIG_FILE, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, { apiKey: string }>;
    expect(providers.anthropic.apiKey).toBe('sk-ant-second');
  });

  it('creates config.yaml if it does not exist', async () => {
    // CONFIG_FILE does not exist in fresh TMP/.studio/ (only the dir is created)
    await addProviderConfig(CONFIG_FILE, 'openai', 'sk-new-key', false);

    const raw = await readFile(CONFIG_FILE, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, { apiKey: string }>;
    expect(providers.openai.apiKey).toBe('sk-new-key');
  });

  it('uses correct defaultModel for openai', async () => {
    await addProviderConfig(CONFIG_FILE, 'openai', 'sk-openai-key', true);

    const raw = await readFile(CONFIG_FILE, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const defaults = parsed.defaults as { model: string };
    expect(defaults.model).toBe('gpt-4o');
  });

  it('uses claude-sonnet fallback for unknown provider', async () => {
    await addProviderConfig(CONFIG_FILE, 'unknown-provider', 'some-key', true);

    const raw = await readFile(CONFIG_FILE, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const defaults = parsed.defaults as { model: string };
    expect(defaults.model).toBe('claude-sonnet-4-20250514');
  });
});
```

### Step 2: Run to verify tests fail

```bash
cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test 2>&1 | tail -20
```

Expected: FAIL — `addProviderConfig` not exported yet.

### Step 3: Add `addProviderConfig` to `config.ts`

Add after `validateApiKeyForProvider` in `cli/src/commands/config.ts`:

```typescript
export async function addProviderConfig(
  configFile: string,
  provider: string,
  apiKey: string,
  setDefault: boolean
): Promise<void> {
  const config = await loadRawConfig(configFile);

  if (!config.providers || typeof config.providers !== 'object') {
    config.providers = {};
  }
  (config.providers as Record<string, unknown>)[provider] = { apiKey };

  if (setDefault) {
    const meta = PROVIDERS.find((p) => p.id === provider);
    config.defaults = {
      provider,
      model: meta?.defaultModel ?? 'claude-sonnet-4-20250514',
    };
  }

  await saveConfig(configFile, config);
}
```

### Step 4: Run tests to verify they pass

```bash
cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test 2>&1 | tail -20
```

Expected: All tests PASS.

### Step 5: Commit

```bash
git add cli/src/commands/config.ts cli/tests/commands/config.test.ts
git commit -m "feat(cli): STU-40 — add addProviderConfig helper"
```

---

## Task 3: Add `isProviderAlreadyConfigured` helper (edge case support)

**Files:**
- Modify: `cli/src/commands/config.ts`
- Test: `cli/tests/commands/config.test.ts`

This is a small helper used by both wizard and direct mode to detect an already-configured provider.

### Step 1: Write the failing test

```typescript
import { isProviderConfigured } from '../../src/commands/config.js';

describe('isProviderConfigured', () => {
  it('returns false when config.yaml does not exist', async () => {
    expect(await isProviderConfigured('/tmp/nonexistent-xyz/config.yaml', 'anthropic')).toBe(false);
  });

  it('returns false when provider not in config', async () => {
    await addProviderConfig(CONFIG_FILE, 'openai', 'sk-key', false);
    expect(await isProviderConfigured(CONFIG_FILE, 'anthropic')).toBe(false);
  });

  it('returns true when provider is in config', async () => {
    await addProviderConfig(CONFIG_FILE, 'anthropic', 'sk-ant-key', false);
    expect(await isProviderConfigured(CONFIG_FILE, 'anthropic')).toBe(true);
  });
});
```

### Step 2: Run to verify test fails

```bash
cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test 2>&1 | tail -20
```

Expected: FAIL.

### Step 3: Add `isProviderConfigured` to `config.ts`

```typescript
export async function isProviderConfigured(configFile: string, provider: string): Promise<boolean> {
  const config = await loadRawConfig(configFile);
  if (!config.providers || typeof config.providers !== 'object') return false;
  return provider in (config.providers as Record<string, unknown>);
}
```

### Step 4: Run tests

```bash
cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test 2>&1 | tail -20
```

Expected: PASS.

### Step 5: Commit

```bash
git add cli/src/commands/config.ts cli/tests/commands/config.test.ts
git commit -m "feat(cli): STU-40 — add isProviderConfigured helper"
```

---

## Task 4: Add wizard function and wire `add-provider` into `configCommand`

**Files:**
- Modify: `cli/src/commands/config.ts`
- Modify: `cli/src/index.ts`

No unit tests for the wizard UI (it requires interactive terminal). The helpers are already tested. Manual smoke test at the end.

### Step 1: Add imports to `config.ts`

At the top of `cli/src/commands/config.ts`, add the inquirer imports:

```typescript
import { select, password, confirm } from '@inquirer/prompts';
```

(Note: `chalk` is already imported.)

### Step 2: Add `configAddProviderWizard` private function

Add before `configCommand` in `cli/src/commands/config.ts`:

```typescript
async function configAddProviderWizard(configFile: string): Promise<void> {
  const config = await loadRawConfig(configFile);
  const existingProviders = config.providers
    ? Object.keys(config.providers as Record<string, unknown>)
    : [];

  // Step 1: Select provider
  const providerId = await select<string>({
    message: 'Which provider would you like to add?',
    choices: PROVIDERS.map((p) => ({ value: p.id, name: p.label })),
  });

  // Step 2: Handle already-configured case
  if (existingProviders.includes(providerId)) {
    const providerLabel = PROVIDERS.find((p) => p.id === providerId)?.label ?? providerId;
    const override = await confirm({
      message: `${providerLabel} is already configured. Override?`,
      default: false,
    });
    if (!override) {
      console.log('Aborted.');
      return;
    }
  }

  // Step 3: Ask for API key (or base URL for local)
  let apiKey = '';
  if (providerId === 'local') {
    const { input } = await import('@inquirer/prompts');
    apiKey = await input({
      message: 'Ollama base URL:',
      default: 'http://localhost:11434',
    });
  } else {
    const providerLabel = PROVIDERS.find((p) => p.id === providerId)?.label ?? providerId;
    apiKey = await password({
      message: `${providerLabel} API Key:`,
      validate: (value: string) => validateApiKeyForProvider(providerId, value),
    });
  }

  // Step 4: Set as default?
  const isFirstProvider = existingProviders.filter((p) => p !== providerId).length === 0;
  const setDefault =
    isFirstProvider ||
    (await confirm({
      message: 'Set as default provider?',
      default: true,
    }));

  // Step 5: Write config
  await addProviderConfig(configFile, providerId, apiKey, setDefault);

  // Step 6: Confirmation output
  const label = PROVIDERS.find((p) => p.id === providerId)?.label ?? providerId;
  console.log('');
  console.log(chalk.green(`✓ ${label} provider configured`));
  if (setDefault) console.log(chalk.green('✓ Set as default'));
  console.log('');
  console.log('You can now run:');
  console.log(`  ${chalk.cyan('studio run <pipeline> --input "..."')}`);
  console.log('');
}
```

### Step 3: Add `'add-provider'` case to `configCommand`

Update the `ConfigOptions` interface and `configCommand` in `cli/src/commands/config.ts`:

```typescript
interface ConfigOptions {
  apiKey?: string;
  project?: string;
  setDefault?: boolean;   // NEW
}
```

Add inside the `switch (action)` block, before `default:`:

```typescript
case 'add-provider': {
  const provider = args[0];

  if (!provider) {
    // Wizard mode
    await configAddProviderWizard(configFile);
    break;
  }

  // Direct mode
  if (provider !== 'local' && !options.apiKey) {
    console.error(`Error: --api-key is required for provider '${provider}'`);
    process.exit(1);
  }

  const apiKey = options.apiKey ?? '';

  if (provider !== 'local') {
    const validation = validateApiKeyForProvider(provider, apiKey);
    if (validation !== true) {
      console.error(`Error: ${validation}`);
      process.exit(1);
    }
  }

  // Check already configured
  const alreadyConfigured = await isProviderConfigured(configFile, provider);
  if (alreadyConfigured) {
    console.error(
      `Error: Provider '${provider}' is already configured. Use 'studio config set' to update it, or run the wizard to override.`
    );
    process.exit(1);
  }

  // Determine setDefault
  const config = await loadRawConfig(configFile);
  const existingCount = config.providers
    ? Object.keys(config.providers as Record<string, unknown>).length
    : 0;
  const setDefault = options.setDefault ?? existingCount === 0;

  await addProviderConfig(configFile, provider, apiKey, setDefault);

  const label = PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
  console.log(chalk.green(`✓ ${label} provider configured`));
  if (setDefault) console.log(chalk.green('✓ Set as default'));
  console.log('');
  break;
}
```

### Step 4: Update `configCommand`'s default error message

Change the default case message to include `add-provider`:

```typescript
default:
  console.error(`Unknown config action: ${action}. Available: list, get, set, add-provider`);
  process.exit(1);
```

### Step 5: Add `--set-default` to `index.ts`

In `cli/src/index.ts`, update the config command:

```typescript
program
  .command('config <action> [args...]')
  .description('Manage Studio configuration (list, get, set, add-provider)')
  .option('--api-key <key>', 'API key (used with: config set provider <name> --api-key <key>; config add-provider <name> --api-key <key>)')
  .option('--set-default', 'Set as default provider (used with: config add-provider)')
  .action(configCommand);
```

### Step 6: Run all CLI tests

```bash
cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test 2>&1 | tail -30
```

Expected: All tests PASS (existing + new).

### Step 7: Commit

```bash
git add cli/src/commands/config.ts cli/src/index.ts
git commit -m "feat(cli): STU-40 — wire add-provider wizard and direct mode into configCommand"
```

---

## Task 5: Build and verify

### Step 1: Build the full monorepo

```bash
cd /home/arianeguay/dev/src/Studio && pnpm build 2>&1 | tail -20
```

Expected: Build succeeds with no TypeScript errors.

### Step 2: Run all tests

```bash
cd /home/arianeguay/dev/src/Studio && pnpm test 2>&1 | tail -30
```

Expected: All tests pass.

### Step 3: Smoke test (manual — optional if in CI)

```bash
# Create a temp project to test against
mkdir -p /tmp/studio-smoke-test && cd /tmp/studio-smoke-test
node /home/arianeguay/dev/src/Studio/cli/dist/index.js init --template blank --project smoke --provider later
# Direct mode:
node /home/arianeguay/dev/src/Studio/cli/dist/index.js config add-provider anthropic --api-key sk-ant-test123 --set-default
# Verify config
node /home/arianeguay/dev/src/Studio/cli/dist/index.js config list
# Cleanup
rm -rf /tmp/studio-smoke-test
```

Expected:
- `config add-provider anthropic --api-key sk-ant-test123 --set-default` outputs `✓ Anthropic (Claude) provider configured` and `✓ Set as default`
- `config list` shows the provider with masked key

### Step 4: Final commit and push

```bash
cd /home/arianeguay/dev/src/Studio
git status
```

If everything is committed, create the PR:

```bash
git push -u origin arianedguay/stu-40-studio-config-add-provider-wizard
gh pr create --title "feat(cli): STU-40 — studio config add-provider wizard" --body "$(cat <<'EOF'
## What

Adds `studio config add-provider` command — interactive wizard and direct mode to configure LLM providers after `studio init`.

## Why

Users who did `studio init --provider later` or who want to add a second provider need a way to configure providers without re-running `studio init`.

## Packages touched

- `cli` — `commands/config.ts`, `index.ts`

## How to test

```bash
# Direct mode
studio config add-provider anthropic --api-key sk-ant-... --set-default
studio config add-provider openai --api-key sk-...

# Wizard mode
studio config add-provider

# Verify
studio config list
```

## Acceptance criteria coverage

- [x] Wizard mode with provider select
- [x] Password-masked API key input
- [x] Format validation (sk-ant-, sk-, AIza)
- [x] set-as-default logic (auto for first provider, prompted for subsequent)
- [x] Direct mode with `--api-key` and `--set-default` flags
- [x] Error on already-configured provider (direct mode)
- [x] Creates config.yaml if it doesn't exist
- [x] All helpers unit-tested

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Notes

- **Network validation deferred:** The spec mentions `appel test au provider` for key validation. Format validation only is implemented here. Network validation can be added in a follow-up issue — it requires provider-specific SDK calls and would block CI environments with no real API keys.
- **Local (Ollama) key field:** Stores base URL in `apiKey` field for simplicity. A future iteration could use a separate `baseUrl` field.
- **`--set-default` in direct mode:** If not passed, auto-sets default when it's the first provider configured. Subsequent providers require explicit `--set-default`.
