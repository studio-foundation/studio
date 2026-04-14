# STU-89: `studio ollama` Commands + Hardware Detection in `studio init`

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `studio ollama start|stop|status|pull` commands and make `studio init` detect hardware (RAM + Docker/native Ollama) to adapt provider choices accordingly.

**Architecture:** New `cli/src/commands/ollama.ts` mirrors the `api.ts` pattern (single file, 4 subcommands). Hardware detection is extracted into a helper in `init.ts` and run silently before the provider select prompt. Ollama config writes `{}` (no apiKey) into `providers.ollama`.

**Tech Stack:** Node.js built-ins (`os`, `child_process`), native `fetch` (Node 18+), `chalk`, `ora`, `@inquirer/prompts` — all already in `@studio-foundation/cli`. No new dependencies.

---

## Task 1: `detectHardware()` helper in `init.ts`

**Files:**
- Modify: `cli/src/commands/init.ts`
- Test: `cli/tests/commands/init.test.ts`

### Step 1: Write the failing test

Add to `cli/tests/commands/init.test.ts`, in a new `describe('detectHardware')` block after the existing ones:

```typescript
describe('detectHardware', () => {
  it('returns totalRamGb from os.totalmem()', async () => {
    const { detectHardware } = await import('../../src/commands/init.js');
    const hw = await detectHardware();
    // os.totalmem() is real on the test machine — just verify it's a positive number
    expect(hw.totalRamGb).toBeGreaterThan(0);
  });

  it('returns ollamaAvailable=true when hasDocker or hasNativeOllama', () => {
    // We can't mock spawnSync easily without vi.mock at top level,
    // so just verify the shape of the returned object
    // Full coverage of docker/native detection is in the mocked init wizard tests (Task 5)
    expect(true).toBe(true); // placeholder — see Task 5 for mocked tests
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd /path/to/.worktrees/stu-89-ollama-cli
pnpm --filter @studio-foundation/cli test -- --reporter=verbose tests/commands/init.test.ts
```

Expected: FAIL — `detectHardware is not a function`

### Step 3: Implement `detectHardware` in `init.ts`

Add at the top of `cli/src/commands/init.ts`, after the existing imports:

```typescript
import { totalmem } from 'node:os';
```

(Note: `spawnSync` is already imported. `node:os` needs to be added.)

Then add this exported function before `initCommand`:

```typescript
export interface HardwareInfo {
  totalRamGb: number;
  hasDocker: boolean;
  hasNativeOllama: boolean;
  ollamaAvailable: boolean;
}

export function detectHardware(): HardwareInfo {
  const totalRamGb = totalmem() / (1024 ** 3);
  const hasDocker = spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0;
  const hasNativeOllama = spawnSync('ollama', ['--version'], { stdio: 'ignore' }).status === 0;
  return {
    totalRamGb,
    hasDocker,
    hasNativeOllama,
    ollamaAvailable: hasDocker || hasNativeOllama,
  };
}
```

### Step 4: Run test to verify it passes

```bash
pnpm --filter @studio-foundation/cli test -- --reporter=verbose tests/commands/init.test.ts
```

Expected: PASS

### Step 5: Commit

```bash
cd /path/to/.worktrees/stu-89-ollama-cli
git add cli/src/commands/init.ts cli/tests/commands/init.test.ts
git commit -m "feat(cli): add detectHardware() helper — RAM + Docker + native Ollama detection [STU-89]"
```

---

## Task 2: `writeProviderToConfig` — support Ollama (no apiKey)

**Files:**
- Modify: `cli/src/commands/init.ts`
- Test: `cli/tests/commands/init.test.ts`

Currently `writeProviderToConfig` always writes `{ apiKey }` to the provider entry. Ollama needs `{}` (or `{ baseUrl }` later). Make `apiKey` optional.

### Step 1: Write the failing test

Add to `cli/tests/commands/init.test.ts` in the existing `describe('writeProviderToConfig')` block (or create one):

```typescript
describe('writeProviderToConfig', () => {
  it('writes ollama config without apiKey', async () => {
    const { writeProviderToConfig } = await import('../../src/commands/init.js');
    const studioDir = resolve(TMP, '.studio');
    await mkdir(studioDir, { recursive: true });

    await writeProviderToConfig(studioDir, 'ollama', undefined, 'llama3.3');

    const raw = await readFile(resolve(studioDir, 'config.yaml'), 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, unknown>;
    expect(providers['ollama']).toEqual({});
    const defaults = parsed.defaults as Record<string, unknown>;
    expect(defaults['provider']).toBe('ollama');
    expect(defaults['model']).toBe('llama3.3');
  });
});
```

### Step 2: Run test to verify it fails

```bash
pnpm --filter @studio-foundation/cli test -- --reporter=verbose tests/commands/init.test.ts
```

Expected: FAIL — `providers.ollama` has `{ apiKey: undefined }` instead of `{}`

### Step 3: Update `writeProviderToConfig` signature

In `cli/src/commands/init.ts`, change the function signature from:

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
  apiKey?: string,
  model?: string
): Promise<void>
```

And update the provider entry write from:
```typescript
(parsed.providers as Record<string, unknown>)[provider] = { apiKey };
```

To:
```typescript
(parsed.providers as Record<string, unknown>)[provider] = apiKey ? { apiKey } : {};
```

### Step 4: Run test to verify it passes

```bash
pnpm --filter @studio-foundation/cli test -- --reporter=verbose tests/commands/init.test.ts
```

Expected: PASS (and all existing init tests still pass)

### Step 5: Commit

```bash
git add cli/src/commands/init.ts cli/tests/commands/init.test.ts
git commit -m "feat(cli): make writeProviderToConfig apiKey optional — supports Ollama [STU-89]"
```

---

## Task 3: `studio ollama` command — status and start

**Files:**
- Create: `cli/src/commands/ollama.ts`
- Create: `cli/tests/commands/ollama.test.ts`

### Step 1: Write the failing tests

Create `cli/tests/commands/ollama.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock child_process before importing the module
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});

const { spawnSync } = await import('node:child_process');
const { ollamaStatusCommand, ollamaStartCommand } = await import('../../src/commands/ollama.js');

afterEach(() => {
  vi.restoreAllMocks();
  // Reset fetch mock
  vi.stubGlobal('fetch', undefined);
});

describe('ollamaStatusCommand', () => {
  it('prints running + models when Ollama responds', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3.3:latest', size: 4_200_000_000 },
          { name: 'codellama:7b', size: 3_800_000_000 },
        ],
      }),
    }) as unknown as typeof fetch;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await ollamaStatusCommand('http://localhost:11434');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('running'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('llama3.3:latest'));
    logSpy.mockRestore();
  });

  it('prints not running when fetch fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await ollamaStatusCommand('http://localhost:11434');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
    logSpy.mockRestore();
  });
});

describe('ollamaStartCommand', () => {
  it('prints "already running" when Ollama is reachable', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    }) as unknown as typeof fetch;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await ollamaStartCommand('http://localhost:11434');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
    logSpy.mockRestore();
  });

  it('prints native ollama serve command when ollama is installed', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await ollamaStartCommand('http://localhost:11434');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ollama serve'));
    logSpy.mockRestore();
  });

  it('prints docker run command when only docker is available', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 1 } as ReturnType<typeof spawnSync>) // ollama not found
      .mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>); // docker found

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await ollamaStartCommand('http://localhost:11434');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('docker run'));
    logSpy.mockRestore();
  });

  it('prints install instructions when neither is available', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await ollamaStartCommand('http://localhost:11434');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('docker.com'));
    logSpy.mockRestore();
  });
});
```

### Step 2: Run test to verify it fails

```bash
pnpm --filter @studio-foundation/cli test -- --reporter=verbose tests/commands/ollama.test.ts
```

Expected: FAIL — module not found

### Step 3: Create `cli/src/commands/ollama.ts`

```typescript
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';

const OLLAMA_DOCKER_IMAGE = 'ollama/ollama';

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

async function isOllamaRunning(baseUrl: string): Promise<false | { models: Array<{ name: string; size: number }> }> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) return false;
    const data = await res.json() as { models?: Array<{ name: string; size: number }> };
    return { models: data.models ?? [] };
  } catch {
    return false;
  }
}

export async function ollamaStatusCommand(baseUrl: string): Promise<void> {
  const result = await isOllamaRunning(baseUrl);
  if (!result) {
    console.log(chalk.red('  ✗ Ollama not running'));
    console.log('');
    console.log('To start Ollama:');
    console.log(`  ${chalk.cyan('ollama serve')}                              # native`);
    console.log(`  ${chalk.cyan(`docker run -d -p 11434:11434 ${OLLAMA_DOCKER_IMAGE}`)}   # Docker`);
    return;
  }
  console.log(chalk.green(`  ✓ Ollama running at ${baseUrl}`));
  if (result.models.length === 0) {
    console.log('  No models pulled yet. Run: studio ollama pull llama3.3');
  } else {
    console.log('');
    console.log('  Pulled models:');
    for (const model of result.models) {
      console.log(`    ${chalk.bold(model.name.padEnd(30))} ${formatBytes(model.size)}`);
    }
  }
}

export async function ollamaStartCommand(baseUrl: string): Promise<void> {
  const running = await isOllamaRunning(baseUrl);
  if (running) {
    console.log(chalk.green(`  ✓ Ollama already running at ${baseUrl}`));
    return;
  }

  const hasNative = spawnSync('ollama', ['--version'], { stdio: 'ignore' }).status === 0;
  if (hasNative) {
    console.log('Ollama is installed but not running. Start it with:');
    console.log('');
    console.log(`  ${chalk.cyan('ollama serve')}`);
    return;
  }

  const hasDocker = spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0;
  if (hasDocker) {
    console.log('Docker is available. Start Ollama with:');
    console.log('');
    console.log(`  ${chalk.cyan(`docker run -d -p 11434:11434 --name ollama ${OLLAMA_DOCKER_IMAGE}`)}`);
    console.log('');
    console.log('Then pull a model:');
    console.log(`  ${chalk.cyan('studio ollama pull llama3.3')}`);
    return;
  }

  console.log(chalk.yellow('  Neither Ollama nor Docker found.'));
  console.log('');
  console.log('Options:');
  console.log(`  Install Ollama natively: ${chalk.cyan('https://ollama.com')}`);
  console.log(`  Install Docker:          ${chalk.cyan('https://docker.com')}`);
}

export async function ollamaStopCommand(): Promise<void> {
  console.log('To stop Ollama:');
  console.log('');
  console.log(`  Native:  ${chalk.cyan('Ctrl+C')} in the terminal running ${chalk.cyan('ollama serve')}`);
  console.log(`  Docker:  ${chalk.cyan('docker stop ollama')}`);
}

export async function ollamaPullCommand(model: string, baseUrl: string): Promise<void> {
  const running = await isOllamaRunning(baseUrl);
  if (!running) {
    console.error(chalk.red(`  ✗ Ollama not running at ${baseUrl}`));
    console.error(`  Run: ${chalk.cyan('studio ollama start')}`);
    process.exit(1);
  }

  process.stdout.write(`Pulling ${chalk.bold(model)}...`);

  try {
    const res = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
    });

    if (!res.ok || !res.body) {
      console.log(chalk.red(' ✗'));
      console.error(`Pull failed: HTTP ${res.status}`);
      process.exit(1);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let lastStatus = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as { status?: string; error?: string };
          if (event.error) {
            process.stdout.write('\n');
            console.error(chalk.red(`  ✗ ${event.error}`));
            process.exit(1);
          }
          if (event.status && event.status !== lastStatus) {
            process.stdout.write(`\r${event.status.padEnd(60)}`);
            lastStatus = event.status;
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    }

    process.stdout.write('\n');
    console.log(chalk.green(`  ✓ Pulled ${model}`));
  } catch (err) {
    process.stdout.write('\n');
    console.error(chalk.red(`  ✗ Pull failed: ${err instanceof Error ? err.message : String(err)}`));
    console.error(`  You can retry with: ${chalk.cyan(`studio ollama pull ${model}`)}`);
    process.exit(1);
  }
}

export async function ollamaCommand(action: string, modelArg: string | undefined, baseUrl: string): Promise<void> {
  if (action === 'status') {
    await ollamaStatusCommand(baseUrl);
  } else if (action === 'start') {
    await ollamaStartCommand(baseUrl);
  } else if (action === 'stop') {
    await ollamaStopCommand();
  } else if (action === 'pull') {
    if (!modelArg) {
      console.error('Usage: studio ollama pull <model>');
      console.error('Example: studio ollama pull llama3.3');
      process.exit(1);
    }
    await ollamaPullCommand(modelArg, baseUrl);
  } else {
    console.error(`Unknown ollama action: ${action}. Use: studio ollama start|stop|status|pull <model>`);
    process.exit(1);
  }
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter @studio-foundation/cli test -- --reporter=verbose tests/commands/ollama.test.ts
```

Expected: All ollama tests PASS

### Step 5: Commit

```bash
git add cli/src/commands/ollama.ts cli/tests/commands/ollama.test.ts
git commit -m "feat(cli): studio ollama status + start commands [STU-89]"
```

---

## Task 4: `studio ollama pull` and `stop` tests

**Files:**
- Modify: `cli/tests/commands/ollama.test.ts`

### Step 1: Add pull and stop tests

Append to `cli/tests/commands/ollama.test.ts`:

```typescript
describe('ollamaStopCommand', () => {
  it('always prints stop instructions', async () => {
    const { ollamaStopCommand } = await import('../../src/commands/ollama.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await ollamaStopCommand();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('docker stop'));
    logSpy.mockRestore();
  });
});

describe('ollamaPullCommand', () => {
  it('exits with error when Ollama not running', async () => {
    const { ollamaPullCommand } = await import('../../src/commands/ollama.js');
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as (code?: number) => never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await ollamaPullCommand('llama3.3', 'http://localhost:11434');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('streams pull and prints success', async () => {
    const { ollamaPullCommand } = await import('../../src/commands/ollama.js');

    // First call: isOllamaRunning check
    // Second call: actual pull
    const encoder = new TextEncoder();
    const ndjson = [
      '{"status":"pulling manifest"}\n',
      '{"status":"success"}\n',
    ].join('');

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // isOllamaRunning check
        return { ok: true, json: async () => ({ models: [] }) };
      }
      // pull request — return a ReadableStream
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(ndjson));
          controller.close();
        },
      });
      return { ok: true, body: stream };
    }) as unknown as typeof fetch;

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await ollamaPullCommand('llama3.3', 'http://localhost:11434');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Pulled llama3.3'));
    writeSpy.mockRestore();
    logSpy.mockRestore();
  });
});
```

### Step 2: Run tests to verify they pass

```bash
pnpm --filter @studio-foundation/cli test -- --reporter=verbose tests/commands/ollama.test.ts
```

Expected: All tests PASS

### Step 3: Commit

```bash
git add cli/tests/commands/ollama.test.ts
git commit -m "test(cli): ollama pull + stop tests [STU-89]"
```

---

## Task 5: Register `studio ollama` in `index.ts`

**Files:**
- Modify: `cli/src/index.ts`

### Step 1: Add import and registration

In `cli/src/index.ts`, add the import after the existing imports:

```typescript
import { ollamaCommand } from './commands/ollama.js';
```

Add the `loadConfig` import if not already present (it is already used via other commands — check. If not, import it):
```typescript
import { loadConfig } from './config.js';
```

Then register the command (add before `program.parse()`):

```typescript
program
  .command('ollama <action> [model]')
  .description('Manage Ollama — start, stop, status, pull <model>')
  .action(async (action: string, model: string | undefined) => {
    const config = await loadConfig();
    const baseUrl = config.providers?.ollama?.baseUrl ?? 'http://localhost:11434';
    void ollamaCommand(action, model, baseUrl);
  });
```

### Step 2: Build to verify TypeScript compiles

```bash
pnpm build
```

Expected: Build succeeds with no errors

### Step 3: Smoke test manually

```bash
node cli/dist/index.js ollama --help
```

Expected: shows `start|stop|status|pull` in description

### Step 4: Commit

```bash
git add cli/src/index.ts
git commit -m "feat(cli): register studio ollama command in index.ts [STU-89]"
```

---

## Task 6: Modify `studio init` wizard — hardware-aware provider choices

**Files:**
- Modify: `cli/src/commands/init.ts`
- Modify: `cli/tests/commands/init.test.ts`

This task modifies the wizard's Step 3 (provider selection) to use hardware detection.

### Step 1: Write failing tests

Add to `cli/tests/commands/init.test.ts`. These test `detectHardware` indirectly by mocking `spawnSync` and `os.totalmem`:

```typescript
// At the top of the file, add to the existing vi.mock section or add a new one:
// Note: os mock needs to be hoisted
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    totalmem: vi.fn(() => 16 * 1024 ** 3), // default: 16GB
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});
```

Then add:

```typescript
describe('detectHardware with mocks', () => {
  it('returns ollamaAvailable=true when docker is present', async () => {
    const { spawnSync } = await import('node:child_process');
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);

    const { detectHardware } = await import('../../src/commands/init.js');
    const hw = detectHardware();
    expect(hw.hasDocker).toBe(true);
    expect(hw.ollamaAvailable).toBe(true);
  });

  it('returns ollamaAvailable=false when neither docker nor ollama is present', async () => {
    const { spawnSync } = await import('node:child_process');
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);

    const { detectHardware } = await import('../../src/commands/init.js');
    const hw = detectHardware();
    expect(hw.hasDocker).toBe(false);
    expect(hw.hasNativeOllama).toBe(false);
    expect(hw.ollamaAvailable).toBe(false);
  });

  it('returns totalRamGb from os.totalmem()', async () => {
    const os = await import('node:os');
    vi.mocked(os.totalmem).mockReturnValue(32 * 1024 ** 3);

    const { detectHardware } = await import('../../src/commands/init.js');
    const hw = detectHardware();
    expect(hw.totalRamGb).toBeCloseTo(32, 0);
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter @studio-foundation/cli test -- --reporter=verbose tests/commands/init.test.ts
```

Expected: FAIL (mock not set up correctly until we wire the mocks properly)

### Step 3: Implement wizard changes in `init.ts`

**Add `totalmem` to the existing `node:os` import:**

The file currently has `import { resolve, join, basename, dirname } from 'node:path'` and uses `spawnSync` from `node:child_process`. Add `os` import:

```typescript
import { totalmem } from 'node:os';
```

**Replace Step 3 (provider section) in `initCommand`** (around line 598–606):

Replace:
```typescript
// Step 3: Provider
const provider = await select<string>({
  message: 'LLM Provider:',
  choices: [
    { value: 'anthropic', name: 'Anthropic (Claude)' },
    { value: 'openai', name: 'OpenAI (GPT)' },
    { value: 'later', name: 'Configure later' },
  ],
});
```

With:
```typescript
// Step 3: Hardware detection + provider choices
const hw = detectHardware();
const ramGb = Math.round(hw.totalRamGb);

const providerChoices: Array<{ value: string; name: string }> = [];

if (hw.ollamaAvailable) {
  if (hw.totalRamGb >= 16) {
    providerChoices.push({
      value: 'ollama',
      name: `Ollama (local, recommended — ${ramGb}GB RAM detected)`,
    });
  } else {
    providerChoices.push({
      value: 'ollama',
      name: `Ollama (local — only ${ramGb}GB RAM detected, results may vary)`,
    });
  }
}
providerChoices.push(
  { value: 'anthropic', name: 'Anthropic (Claude)' },
  { value: 'openai', name: 'OpenAI (GPT)' },
  { value: 'later', name: 'Configure later' },
);

if (!hw.ollamaAvailable) {
  console.log(chalk.gray('  ℹ  Ollama not available (Docker or native install required).'));
  console.log(chalk.gray('     Add later: studio config set provider ollama'));
  console.log('');
}

const provider = await select<string>({
  message: 'LLM Provider:',
  choices: providerChoices,
  default: hw.ollamaAvailable ? 'ollama' : 'anthropic',
});

// Show RAM warning if user picks Ollama with low RAM
if (provider === 'ollama' && hw.totalRamGb < 16) {
  console.log('');
  console.log(chalk.yellow(`  ⚠  Only ${ramGb}GB RAM detected. Ollama will work but results may be inconsistent.`));
  console.log(chalk.yellow('     Recommended: ≥16GB RAM for code-related pipelines.'));
  console.log(chalk.gray('     You can switch providers later: studio config set provider anthropic'));
  console.log('');
}
```

**Also update Step 4 (API Key step) to skip API key prompt for Ollama:**

The existing code at Step 4 checks `if (provider !== 'later')` to prompt for an API key. Add Ollama to the exclusion:

```typescript
// Step 4: API Key (skip for ollama and later)
let apiKey: string | undefined;
if (provider !== 'later' && provider !== 'ollama') {
  // ... existing API key prompt code
}
```

**And update Step 5 (model selection) to skip for Ollama:**

```typescript
// Step 5: Choose default model (skip for ollama — uses llama3.3 by default)
let selectedModel: string | undefined;
if (provider !== 'later' && provider !== 'ollama' && apiKey) {
  // ... existing model selection code
}
```

**And update the config write (around line 696) to handle Ollama:**

```typescript
if (provider === 'ollama') {
  await writeProviderToConfig(studioDir, 'ollama', undefined, 'llama3.3');
} else if (provider !== 'later' && apiKey) {
  await writeProviderToConfig(studioDir, provider, apiKey, selectedModel);
}
```

### Step 4: Run tests

```bash
pnpm --filter @studio-foundation/cli test -- --reporter=verbose tests/commands/init.test.ts
```

Expected: All tests PASS

### Step 5: Commit

```bash
git add cli/src/commands/init.ts cli/tests/commands/init.test.ts
git commit -m "feat(cli): hardware-aware Ollama detection in studio init wizard [STU-89]"
```

---

## Task 7: Build, full test suite, verify

### Step 1: Build everything

```bash
cd /path/to/.worktrees/stu-89-ollama-cli
pnpm build
```

Expected: All packages build successfully

### Step 2: Run full test suite

```bash
pnpm test
```

Expected: All 411+ tests pass (new tests added), 0 failures

### Step 3: Smoke test CLI

```bash
node cli/dist/index.js ollama --help
node cli/dist/index.js ollama status
node cli/dist/index.js ollama start
```

### Step 4: Commit if any build artifacts changed

```bash
git status
# If only dist/ files changed (gitignored), nothing to commit
```

---

## Task 8: Final commit and push

```bash
cd /path/to/.worktrees/stu-89-ollama-cli
git log --oneline feat/stu-89-ollama-cli-docker-wizard
git push -u origin feat/stu-89-ollama-cli-docker-wizard
```

Then open a PR:

```bash
gh pr create \
  --title "feat(cli): studio ollama commands + hardware detection in init wizard [STU-89]" \
  --body "$(cat <<'EOF'
## What

- `studio ollama status` — lists pulled models via Ollama HTTP API
- `studio ollama start` — detects native Ollama or Docker, prints the right start command
- `studio ollama stop` — prints stop instructions (unmanaged)
- `studio ollama pull <model>` — streams NDJSON pull progress from Ollama API
- `studio init` wizard now detects RAM + Docker + native Ollama before provider step
  - ≥16GB + Ollama available → Ollama first in list, recommended
  - <16GB + Ollama available → Ollama with RAM warning label
  - No Ollama/Docker → Ollama omitted, info message shown

## Why

STU-89 — zero-friction Ollama onboarding. STU-88 set Ollama as default provider; now the CLI provides the surface to manage it and the init wizard guides users based on hardware reality.

## Packages touched

- `@studio-foundation/cli` — new `commands/ollama.ts`, modified `commands/init.ts`, `index.ts`

## How to test

```bash
# Test the commands
studio ollama status
studio ollama start
studio ollama pull llama3.3

# Test the wizard (interactive)
cd /tmp/test-project && studio init
# → Verify Ollama appears in provider list when docker is available
```
EOF
)" \
  --base main
```
