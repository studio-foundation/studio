# Ollama Default Provider Implementation Plan [STU-88]

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Ollama the ideological default in `studio init`, with hardware detection to adapt the wizard to the user's actual setup.

**Architecture:** All changes are in `@studio/cli` only. Detection logic (`os.totalmem()` + `spawnSync('ollama', ['--version'])`) runs inline before the provider selection step in the wizard. `writeProviderToConfig` gets a signature update to handle Ollama's credential format (no apiKey). The config template switches default to ollama/llama3.3.

**Tech Stack:** TypeScript, Node.js `os` + `child_process`, Inquirer (`@inquirer/prompts`), Vitest, js-yaml.

---

## Important: test file context

The test file is `cli/tests/commands/init.test.ts`. It already:
- Mocks `@studio/runner` (vi.mock at the top)
- Mocks `../../src/commands/registry/install.js`
- Uses dynamic imports inside each `it()`: `const { fn } = await import('../../src/commands/init.js')`
- Uses `/tmp/.studio-init-test-<unique>` as TMP dir (NEVER a subdir of the Studio repo — `findStudioDir` walks up and would find `.studio/` in the repo root)

All commands run from the worktree: `/home/arianeguay/dev/src/Studio/.worktrees/stu-88-ollama-default/`

---

### Task 1: Detection helpers — tests first

**Files:**
- Modify: `cli/tests/commands/init.test.ts`
- Modify: `cli/src/commands/init.ts`

**Step 1: Add mock for `node:child_process` and `node:os` at the top of the test file**

Open `cli/tests/commands/init.test.ts`. After the existing `vi.mock` blocks (around line 9), add:

```typescript
// Mock node:child_process so detectOllamaInstalled doesn't run real shell commands
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawnSync: vi.fn().mockReturnValue({ status: 0 }), // default: all commands succeed
  };
});

// Mock node:os so hasAdequateRam doesn't read real hardware
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return {
    ...original,
    totalmem: vi.fn().mockReturnValue(32 * 1024 ** 3), // default: 32GB
  };
});
```

**Step 2: Write failing tests for `detectOllamaInstalled`**

Add a new `describe` block at the end of the test file:

```typescript
describe('detectOllamaInstalled', () => {
  let spawnSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const childProcess = await import('node:child_process');
    spawnSyncMock = vi.mocked(childProcess.spawnSync);
  });

  it('returns true when ollama --version exits 0', async () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    const { detectOllamaInstalled } = await import('../../src/commands/init.js');
    expect(detectOllamaInstalled()).toBe(true);
  });

  it('returns false when ollama --version exits non-zero', async () => {
    spawnSyncMock.mockReturnValue({ status: 1 });
    const { detectOllamaInstalled } = await import('../../src/commands/init.js');
    expect(detectOllamaInstalled()).toBe(false);
  });

  it('returns false when ollama is not found (status null)', async () => {
    spawnSyncMock.mockReturnValue({ status: null });
    const { detectOllamaInstalled } = await import('../../src/commands/init.js');
    expect(detectOllamaInstalled()).toBe(false);
  });
});

describe('hasAdequateRam', () => {
  let totalMemMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const os = await import('node:os');
    totalMemMock = vi.mocked(os.totalmem);
  });

  it('returns true when RAM >= 16GB', async () => {
    totalMemMock.mockReturnValue(16 * 1024 ** 3);
    const { hasAdequateRam } = await import('../../src/commands/init.js');
    expect(hasAdequateRam()).toBe(true);
  });

  it('returns true when RAM > 16GB', async () => {
    totalMemMock.mockReturnValue(32 * 1024 ** 3);
    const { hasAdequateRam } = await import('../../src/commands/init.js');
    expect(hasAdequateRam()).toBe(true);
  });

  it('returns false when RAM < 16GB', async () => {
    totalMemMock.mockReturnValue(8 * 1024 ** 3);
    const { hasAdequateRam } = await import('../../src/commands/init.js');
    expect(hasAdequateRam()).toBe(false);
  });

  it('returns false when os.totalmem throws', async () => {
    totalMemMock.mockImplementation(() => { throw new Error('no access'); });
    const { hasAdequateRam } = await import('../../src/commands/init.js');
    expect(hasAdequateRam()).toBe(false);
  });
});
```

**Step 3: Run tests to verify they fail**

```bash
cd /home/arianeguay/dev/src/Studio/.worktrees/stu-88-ollama-default
pnpm --filter @studio/cli test 2>&1 | grep -A 3 "detectOllamaInstalled\|hasAdequateRam"
```

Expected: FAIL — `detectOllamaInstalled is not a function` (not exported yet)

**Step 4: Add `import os from 'node:os'` and implement + export the helpers in `init.ts`**

In `cli/src/commands/init.ts`, add `os` to the imports at the top:
```typescript
import os from 'node:os';
```

Then add these two exported functions right after the `DEFAULT_MODELS` constant (around line 171):

```typescript
export function detectOllamaInstalled(): boolean {
  return spawnSync('ollama', ['--version'], { stdio: 'ignore' }).status === 0;
}

const RAM_16GB = 16 * 1024 ** 3;

export function hasAdequateRam(): boolean {
  try {
    return os.totalmem() >= RAM_16GB;
  } catch {
    return false;
  }
}
```

Also add `ollama` to `DEFAULT_MODELS`:
```typescript
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  ollama: 'llama3.3',
};
```

**Step 5: Run tests to verify they pass**

```bash
pnpm --filter @studio/cli test 2>&1 | grep -E "detectOllamaInstalled|hasAdequateRam|PASS|FAIL"
```

Expected: all new tests PASS

**Step 6: Commit**

```bash
cd /home/arianeguay/dev/src/Studio/.worktrees/stu-88-ollama-default
git add cli/src/commands/init.ts cli/tests/commands/init.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add detectOllamaInstalled and hasAdequateRam helpers [STU-88]

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Update `writeProviderToConfig` for Ollama — tests first

**Files:**
- Modify: `cli/tests/commands/init.test.ts`
- Modify: `cli/src/commands/init.ts`

**Context:** `writeProviderToConfig` currently takes `apiKey: string` as third param. Ollama doesn't use an API key — its providers block is just `{}` or `{ baseUrl: string }`. We change the signature to accept `credentials: { apiKey?: string; baseUrl?: string }`.

All existing callers in the test file pass a raw string like `'sk-ant-test-key'`. These need to be updated to pass `{ apiKey: 'sk-ant-test-key' }`.

**Step 1: Write a failing test for the Ollama case**

Find the `describe('writeProviderToConfig', ...)` block in `cli/tests/commands/init.test.ts` (around line 369) and add this test at the end of that describe block:

```typescript
it('writes ollama config with empty credentials and llama3.3 default model', async () => {
  const { createStudioStructure, writeProviderToConfig } = await import('../../src/commands/init.js');
  await createStudioStructure(TMP);
  const studioDir = resolve(TMP, '.studio');
  await writeProviderToConfig(studioDir, 'ollama', {});

  const raw = await readFile(resolve(studioDir, 'config.yaml'), 'utf-8');
  const parsed = yaml.load(raw) as Record<string, unknown>;
  const providers = parsed.providers as Record<string, unknown>;
  expect(providers.ollama).toEqual({});
  expect(providers.ollama).not.toHaveProperty('apiKey');
  const defaults = parsed.defaults as { provider: string; model: string };
  expect(defaults.provider).toBe('ollama');
  expect(defaults.model).toBe('llama3.3');
});
```

**Step 2: Run to verify it fails**

```bash
pnpm --filter @studio/cli test 2>&1 | grep -A 5 "writes ollama config"
```

Expected: FAIL — wrong number of arguments or `apiKey` still written

**Step 3: Update `writeProviderToConfig` signature in `init.ts`**

Change the function signature from:
```typescript
export async function writeProviderToConfig(
  studioDir: string,
  provider: string,
  apiKey: string,
  model?: string
): Promise<void>
```

To:
```typescript
export async function writeProviderToConfig(
  studioDir: string,
  provider: string,
  credentials: { apiKey?: string; baseUrl?: string },
  model?: string
): Promise<void>
```

Update the body where it sets the provider config:
```typescript
// Before:
(parsed.providers as Record<string, unknown>)[provider] = { apiKey };

// After:
if (provider === 'ollama') {
  (parsed.providers as Record<string, unknown>)[provider] =
    credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {};
} else {
  (parsed.providers as Record<string, unknown>)[provider] =
    credentials.apiKey ? { apiKey: credentials.apiKey } : {};
}
```

Update the model fallback line:
```typescript
// Before:
model: model ?? DEFAULT_MODELS[provider] ?? 'claude-sonnet-4-20250514',

// After:
model: model ?? DEFAULT_MODELS[provider] ?? 'claude-sonnet-4-20250514',
// (no change needed here — DEFAULT_MODELS now has 'ollama' key)
```

**Step 4: Update all call sites of `writeProviderToConfig` in `init.ts`**

Search for all `writeProviderToConfig(` calls in `init.ts` and update them:

```typescript
// Direct mode (around line 519):
// Before:
await writeProviderToConfig(studioDir, options.provider!, options.apiKey);
// After:
await writeProviderToConfig(studioDir, options.provider!, { apiKey: options.apiKey });

// Wizard mode (around line 698):
// Before:
await writeProviderToConfig(studioDir, provider, apiKey, selectedModel);
// After:
await writeProviderToConfig(studioDir, provider, { apiKey }, selectedModel);
```

Also update `directInit` which passes apiKey:
```typescript
// Before (around line 226):
await writeProviderToConfig(studioDir, provider, apiKey);
// After:
await writeProviderToConfig(studioDir, provider, { apiKey });
```

**Step 5: Update existing `writeProviderToConfig` tests to use new signature**

In `cli/tests/commands/init.test.ts`, find all calls to `writeProviderToConfig` in tests and update:
```typescript
// Before:
await writeProviderToConfig(studioDir, 'anthropic', 'sk-ant-test-key');
// After:
await writeProviderToConfig(studioDir, 'anthropic', { apiKey: 'sk-ant-test-key' });

// And:
await writeProviderToConfig(studioDir, 'openai', 'sk-openai-test-key');
// After:
await writeProviderToConfig(studioDir, 'openai', { apiKey: 'sk-openai-test-key' });

// And both:
await writeProviderToConfig(studioDir, 'anthropic', 'sk-ant-first');
await writeProviderToConfig(studioDir, 'anthropic', 'sk-ant-second');
// After:
await writeProviderToConfig(studioDir, 'anthropic', { apiKey: 'sk-ant-first' });
await writeProviderToConfig(studioDir, 'anthropic', { apiKey: 'sk-ant-second' });
```

**Step 6: Run tests to verify all pass**

```bash
pnpm --filter @studio/cli test 2>&1 | tail -10
```

Expected: all tests PASS (count should be higher by 1)

**Step 7: Commit**

```bash
git add cli/src/commands/init.ts cli/tests/commands/init.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): update writeProviderToConfig signature for Ollama credentials [STU-88]

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Update `directInit` for Ollama — tests first

**Files:**
- Modify: `cli/tests/commands/init.test.ts`
- Modify: `cli/src/commands/init.ts`

**Context:** `directInit` currently requires a non-empty `apiKey` when `provider !== 'later'`. Ollama is a valid provider that needs no API key. The `initCommand` direct mode also validates and live-checks the key — both must skip for Ollama.

**Step 1: Write failing test**

Find `describe('directInit', ...)` block in the test file and add:

```typescript
it('succeeds with provider ollama and no api key', async () => {
  const { directInit } = await import('../../src/commands/init.js');
  // Should not throw — Ollama needs no API key
  await directInit(TMP, 'software', 'ollama', '');
  const studioDir = resolve(TMP, '.studio');
  const raw = await readFile(resolve(studioDir, 'config.yaml'), 'utf-8');
  const parsed = yaml.load(raw) as Record<string, unknown>;
  const providers = parsed.providers as Record<string, unknown>;
  expect(providers.ollama).toEqual({});
  const defaults = parsed.defaults as { provider: string; model: string };
  expect(defaults.provider).toBe('ollama');
  expect(defaults.model).toBe('llama3.3');
});
```

**Step 2: Run to verify it fails**

```bash
pnpm --filter @studio/cli test 2>&1 | grep -A 3 "succeeds with provider ollama"
```

Expected: FAIL (config not written because `provider !== 'later' && !apiKey` branch skips write)

**Step 3: Update `directInit` in `init.ts`**

Find the condition in `directInit` (around line 224):
```typescript
// Before:
if (provider !== 'later' && apiKey) {
  const studioDir = resolve(cwd, '.studio');
  await writeProviderToConfig(studioDir, provider, apiKey);
}

// After:
if (provider !== 'later') {
  const studioDir = resolve(cwd, '.studio');
  await writeProviderToConfig(studioDir, provider, { apiKey: apiKey || undefined });
}
```

**Step 4: Update direct mode in `initCommand` to skip API key validation for Ollama**

Find the direct mode block in `initCommand` (around line 484). The block currently does:
```typescript
if (options.provider !== 'later' && !options.apiKey) {
  console.error('Error: --api-key is required when --provider is not "later"');
  process.exit(1);
}
```

Change to:
```typescript
if (options.provider !== 'later' && options.provider !== 'ollama' && !options.apiKey) {
  console.error('Error: --api-key is required when --provider is not "later" or "ollama"');
  process.exit(1);
}
```

Also skip the API key format validation and live check for Ollama — wrap the validation block:
```typescript
if (options.provider !== 'later' && options.provider !== 'ollama' && options.apiKey) {
  const validation = validateApiKeyFormat(options.provider!, options.apiKey);
  // ... rest of validation unchanged
}
```

**Step 5: Run tests**

```bash
pnpm --filter @studio/cli test 2>&1 | tail -10
```

Expected: all tests PASS

**Step 6: Commit**

```bash
git add cli/src/commands/init.ts cli/tests/commands/init.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): directInit accepts ollama provider without api key [STU-88]

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wizard provider step — Ollama detection + dynamic choices

**Files:**
- Modify: `cli/src/commands/init.ts`

**Context:** The wizard's Step 3 (provider selection) currently hardcodes three choices: Anthropic, OpenAI, later. We add detection before this step and build choices dynamically based on results.

No new tests for this task — the wizard flow uses Inquirer interactively and is verified manually. The detection helpers are already tested (Task 1). The config output for Ollama is already tested (Tasks 2-3).

**Step 1: Add detection before the provider select in the wizard**

In `initCommand`, find the wizard section comment `// Step 3: Provider` (around line 598). Before the `select()` call, add:

```typescript
// Detect Ollama and hardware before building provider choices
const ollamaInstalled = detectOllamaInstalled();
const ramOk = hasAdequateRam();
```

**Step 2: Replace the hardcoded provider choices with dynamic ones**

Replace the existing `select<string>` call for provider (lines ~599–606):

```typescript
// Build provider choices based on detection results
type ProviderChoice =
  | { value: string; name: string }
  | { value: string; name: string; disabled: string };

const providerChoices: ProviderChoice[] = [];

if (ollamaInstalled && !ramOk) {
  // Ollama present but hardware limited: warn, show cloud first, Ollama available
  console.log('');
  console.log(chalk.yellow('  ⚠ Ollama detected but your system has less than 16GB RAM.'));
  console.log(chalk.gray('    Results may be slow or limited for code generation.'));
  console.log(chalk.gray('    You can switch to Ollama later: studio config set provider ollama'));
  console.log('');
  providerChoices.push(
    { value: 'anthropic', name: 'Anthropic (Claude)' },
    { value: 'openai', name: 'OpenAI (GPT)' },
    { value: 'ollama', name: 'Ollama (llama3.3) — installed but limited hardware' },
    { value: 'later', name: 'Configure later' },
  );
} else if (ollamaInstalled) {
  // Ollama present + good hardware: Ollama first, pre-selected
  providerChoices.push(
    { value: 'ollama', name: 'Ollama (llama3.3) — runs locally, no API key needed' },
    { value: 'anthropic', name: 'Anthropic (Claude)' },
    { value: 'openai', name: 'OpenAI (GPT)' },
    { value: 'later', name: 'Configure later' },
  );
} else {
  // Ollama not installed: show as disabled, cloud providers selectable
  providerChoices.push(
    {
      value: 'ollama-disabled',
      name: 'Ollama (not installed — run: ollama pull llama3.3)',
      disabled: 'not installed',
    },
    { value: 'anthropic', name: 'Anthropic (Claude)' },
    { value: 'openai', name: 'OpenAI (GPT)' },
    { value: 'later', name: 'Configure later' },
  );
}

const providerDefault =
  ollamaInstalled && ramOk ? 'ollama'
  : ollamaInstalled ? 'anthropic'
  : 'anthropic';

const provider = await select<string>({
  message: 'LLM Provider:',
  choices: providerChoices,
  default: providerDefault,
});
```

**Step 3: Build**

```bash
pnpm build 2>&1 | tail -5
```

Expected: build succeeds (no TypeScript errors)

**Step 4: Commit**

```bash
git add cli/src/commands/init.ts
git commit -m "$(cat <<'EOF'
feat(cli): wizard provider step — Ollama detection and dynamic choices [STU-88]

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Wizard API key + model steps — skip/simplify for Ollama

**Files:**
- Modify: `cli/src/commands/init.ts`

**Step 1: Skip API key step for Ollama**

Find Step 4 in the wizard (around line 609):
```typescript
// Step 4: API Key
let apiKey: string | undefined;
if (provider !== 'later') {
  const providerLabel = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
  while (true) { ... }
}
```

Change the condition:
```typescript
let apiKey: string | undefined;
if (provider !== 'later' && provider !== 'ollama') {
  const providerLabel = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
  // ... rest of the block unchanged
}
```

**Step 2: Simplify model step for Ollama**

Find Step 5 (around line 634):
```typescript
// Step 5: Choose default model
let selectedModel: string | undefined;
if (provider !== 'later' && apiKey) {
  const models = await getAvailableModels(provider, apiKey);
  // ...
}
```

Change to:
```typescript
let selectedModel: string | undefined;
if (provider === 'ollama') {
  // Don't call remote API — just offer the local default
  selectedModel = await input({
    message: 'Default model:',
    default: 'llama3.3',
  });
} else if (provider !== 'later' && apiKey) {
  const models = await getAvailableModels(provider, apiKey);
  const fallback = DEFAULT_MODELS[provider] ?? 'claude-sonnet-4-20250514';
  // ... rest of existing block unchanged
}
```

**Step 3: Update the config write call in wizard mode for Ollama**

Find where the wizard writes provider config (around line 697):
```typescript
if (provider !== 'later' && apiKey) {
  await writeProviderToConfig(studioDir, provider, { apiKey }, selectedModel);
}
```

Change to:
```typescript
if (provider !== 'later') {
  await writeProviderToConfig(
    studioDir,
    provider,
    provider === 'ollama' ? {} : { apiKey },
    selectedModel
  );
}
```

**Step 4: Fix the "Configure later" help text at the end of the wizard**

Find the block that prints the API key instruction when `provider === 'later'` (around line 751):
```typescript
if (provider === 'later') {
  console.log('');
  console.log('Set your API key first:');
  console.log(
    `  ${chalk.cyan('studio config set provider anthropic --api-key $ANTHROPIC_API_KEY')}`
  );
}
```

Change to offer Ollama as the recommended starting point:
```typescript
if (provider === 'later') {
  console.log('');
  console.log('Set your provider first:');
  console.log(`  ${chalk.cyan('studio config set provider ollama')}              # local, no API key`);
  console.log(`  ${chalk.cyan('studio config set provider anthropic --api-key $ANTHROPIC_API_KEY')}`);
}
```

Also update the same block in direct mode (around line 545):
```typescript
if (options.provider === 'later') {
  console.log('');
  console.log('Set your provider first:');
  console.log(`  ${chalk.cyan('studio config set provider ollama')}              # local, no API key`);
  console.log(`  ${chalk.cyan('studio config set provider anthropic --api-key $ANTHROPIC_API_KEY')}`);
}
```

**Step 5: Build**

```bash
pnpm build 2>&1 | tail -5
```

Expected: no errors

**Step 6: Run full tests**

```bash
pnpm --filter @studio/cli test 2>&1 | tail -10
```

Expected: all tests PASS (same count as before + new tests from Tasks 1-3)

**Step 7: Commit**

```bash
git add cli/src/commands/init.ts
git commit -m "$(cat <<'EOF'
feat(cli): skip API key step and simplify model step for Ollama in wizard [STU-88]

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Config template + full build + final verification

**Files:**
- Modify: `cli/templates/studio-config.yaml`

**Step 1: Update the config template**

Replace the contents of `cli/templates/studio-config.yaml` with:

```yaml
# Studio Configuration
# This file is gitignored — it contains secrets.
# See .studio/projects/ for your pipeline configs (those ARE committed).

providers:
  ollama: {}
  # anthropic:
  #   apiKey: ${ANTHROPIC_API_KEY}
  # openai:
  #   apiKey: ${OPENAI_API_KEY}

defaults:
  provider: ollama
  model: llama3.3
```

**Step 2: Full build**

```bash
cd /home/arianeguay/dev/src/Studio/.worktrees/stu-88-ollama-default
pnpm build 2>&1 | tail -10
```

Expected: all packages build cleanly

**Step 3: Full test run**

```bash
pnpm test 2>&1 | tail -15
```

Expected: all tests pass. Note the final test counts — if any existing tests fail due to the config template change (e.g. a test that checks the template's `provider: anthropic`), fix them to expect `provider: ollama`.

**Step 4: Check for template-related test breakage**

```bash
pnpm test 2>&1 | grep -E "FAIL|provider.*anthropic|studio-config" | head -20
```

If any test asserts the template's default provider is `anthropic`, update the assertion to `ollama`. Most tests use `directInit` which overwrites the template anyway, so breakage here is unlikely.

**Step 5: Commit**

```bash
git add cli/templates/studio-config.yaml
git commit -m "$(cat <<'EOF'
feat(cli): switch studio-config.yaml template default to ollama/llama3.3 [STU-88]

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Final verification + PR

**Step 1: Run full test suite one more time**

```bash
cd /home/arianeguay/dev/src/Studio/.worktrees/stu-88-ollama-default
pnpm test 2>&1 | tail -15
```

Expected: all tests pass, zero failures

**Step 2: Review git log**

```bash
git log --oneline main..HEAD
```

Expected: 6 commits (design doc + 5 implementation commits)

**Step 3: Push**

```bash
git push -u origin arianedguay/stu-88-switcher-le-default-provider-vers-ollama
```

**Step 4: Create PR**

```bash
gh pr create \
  --title "feat(cli): Ollama as default provider with hardware detection [STU-88]" \
  --body "$(cat <<'EOF'
## What

Makes Ollama the ideological default in `studio init` — no API key, no corporate dependency.

Hardware detection adapts the wizard to the user's actual setup:
- **Ollama + ≥16GB RAM** → Ollama pre-selected, shown first
- **Ollama + <16GB RAM** → warning printed, cloud providers pre-selected, Ollama available
- **Ollama not installed** → Ollama shown as disabled with install hint, cloud providers selectable

## Why

Studio's positioning: runs locally, no account required. The wizard should reflect this by default. A bad default is worse than a political one — hence the hardware gate.

## Packages touched

- `@studio/cli` — `init.ts`, `studio-config.yaml` template

## How to test

```bash
# With Ollama installed + good hardware:
studio init  # Ollama should be pre-selected

# Direct mode, no API key:
studio init --template software --provider ollama --name my-app
cat .studio/config.yaml  # Should show provider: ollama, model: llama3.3

# Without Ollama (uninstall or mock):
studio init  # Should show Ollama as disabled, Anthropic pre-selected
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" \
  --base main
```
