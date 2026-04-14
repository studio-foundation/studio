# STU-35: `.studio/` Migration — Configs in User Repo

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move Studio config/project files from `engine/configs/` and `.studiorc.yaml` into `.studio/` — making Studio behave like `git` (`.studio/` lives in the user's project, not in Studio itself).

**Architecture:** Add `findStudioDir()` that walks up the directory tree, update config loading to read from `.studio/config.yaml` (with `.studiorc.yaml` backward compat), update all CLI commands to default configs dir to `.studio/projects/`, and add `studio config` + `studio tools` subcommands.

**Tech Stack:** TypeScript, Node.js `fs/promises`, `js-yaml`, `commander`, `vitest`

---

## Context / What's Already Done

- `.studio/runs/` already used by `run-logger.ts` ✓
- `.studio/` dir exists at repo root ✓
- `engine/configs/` was removed in STU-36 (the monorepo migration) — configs now live in user's repo ✓
- All tests should be run with: `pnpm test` (root) or `pnpm --filter @studio-foundation/cli test`

## Key Decisions

- `findStudioDir()` lives in `cli/src/studio-dir.ts` (CLI owns the filesystem; engine stays domain-agnostic)
- Default configs dir when `.studio/` found: `<studioDir>/projects/`
- Default configs dir when `.studio/` NOT found: `./configs` (backward compat)
- `studio config set` uses dotted-path format: `providers.anthropic.apiKey`, `defaults.model`
- `studio config set provider <name> --api-key <key>` is a convenience alias (matches CLAUDE.md spec)
- `studio tools add` copies from built-in tool templates bundled in CLI (`cli/templates/tools/`)
- `studio tools remove` deletes the `.tool.yaml` file from the project

---

## Task 1: `findStudioDir()` utility

**Files:**
- Create: `cli/src/studio-dir.ts`
- Create: `cli/tests/studio-dir.test.ts`

**Step 1: Write the failing test**

```typescript
// cli/tests/studio-dir.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { findStudioDir } from '../src/studio-dir.js';

const TMP = resolve(import.meta.dirname, '.tmp-studio-dir-test');

beforeEach(async () => { await mkdir(TMP, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

describe('findStudioDir', () => {
  it('finds .studio/ in the given directory', async () => {
    await mkdir(resolve(TMP, '.studio'), { recursive: true });
    const result = await findStudioDir(TMP);
    expect(result).toBe(resolve(TMP, '.studio'));
  });

  it('finds .studio/ in a parent directory', async () => {
    await mkdir(resolve(TMP, '.studio'), { recursive: true });
    const nested = resolve(TMP, 'a', 'b', 'c');
    await mkdir(nested, { recursive: true });
    const result = await findStudioDir(nested);
    expect(result).toBe(resolve(TMP, '.studio'));
  });

  it('returns null when .studio/ is not found', async () => {
    // Use a path with no .studio/ anywhere above it (use /tmp directly)
    const result = await findStudioDir('/tmp');
    expect(result).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @studio-foundation/cli test studio-dir
```
Expected: FAIL — "Cannot find module '../src/studio-dir.js'"

**Step 3: Write minimal implementation**

```typescript
// cli/src/studio-dir.ts
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Walk up the directory tree from `startDir` looking for a `.studio/` directory.
 * Like git looking for `.git/`.
 * Returns the absolute path to `.studio/`, or null if not found.
 */
export async function findStudioDir(startDir: string): Promise<string | null> {
  let current = resolve(startDir);

  while (true) {
    const candidate = join(current, '.studio');
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not found here, go up
    }

    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root
      return null;
    }
    current = parent;
  }
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm --filter @studio-foundation/cli test studio-dir
```
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git checkout -b feat/stu-35-studio-dir-migration
git add cli/src/studio-dir.ts cli/tests/studio-dir.test.ts
git commit -m "feat(cli): add findStudioDir() — walks up tree for .studio/ like git"
```

---

## Task 2: Update `config.ts` to load from `.studio/config.yaml`

**Files:**
- Modify: `cli/src/config.ts`
- Modify: `cli/tests/config.test.ts`

### What Changes

Current: `loadConfig()` looks for `.studiorc.yaml` or `.studiorc.yml` at `process.cwd()`.
New: `loadConfig()` also looks for `.studio/config.yaml` by calling `findStudioDir(cwd)`.

Priority order:
1. If explicit `configPath` passed → use it (no change)
2. Otherwise: try `<studioDir>/config.yaml` (via `findStudioDir`)
3. Fallback: `.studiorc.yaml` / `.studiorc.yml` at `cwd`

Also add `resolvedStudioDir` to the return so callers can use it to resolve `projects/`.

New `StudioConfig` type — add `resolvedStudioDir?: string` at top level (not in YAML, added at load time).

**Step 1: Write the failing tests** (add to existing `cli/tests/config.test.ts`)

```typescript
// Add these tests to the existing config.test.ts describe block

it('should load .studio/config.yaml when present', async () => {
  const studioDir = resolve(TEST_DIR, '.studio');
  await mkdir(studioDir, { recursive: true });
  await writeFile(
    resolve(studioDir, 'config.yaml'),
    `providers:\n  anthropic:\n    apiKey: studio-key\ndefaults:\n  provider: anthropic\n`
  );
  // loadConfig with cwd = TEST_DIR should find .studio/config.yaml
  const config = await loadConfig(undefined, TEST_DIR);
  expect(config.providers?.anthropic?.apiKey).toBe('studio-key');
  expect(config.resolvedStudioDir).toBe(studioDir);
});

it('should fall back to .studiorc.yaml when no .studio/', async () => {
  const configPath = resolve(TEST_DIR, '.studiorc.yaml');
  await writeFile(configPath, `providers:\n  openai:\n    apiKey: fallback-key\n`);
  const config = await loadConfig(undefined, TEST_DIR);
  expect(config.providers?.openai?.apiKey).toBe('fallback-key');
  expect(config.resolvedStudioDir).toBeUndefined();
});

it('loadConfig with explicit path ignores .studio/', async () => {
  const studioDir = resolve(TEST_DIR, '.studio');
  await mkdir(studioDir, { recursive: true });
  await writeFile(resolve(studioDir, 'config.yaml'), `providers:\n  anthropic:\n    apiKey: studio-key\n`);
  const explicit = resolve(TEST_DIR, 'explicit.yaml');
  await writeFile(explicit, `providers:\n  openai:\n    apiKey: explicit-key\n`);
  const config = await loadConfig(explicit, TEST_DIR);
  expect(config.providers?.openai?.apiKey).toBe('explicit-key');
});
```

**Step 2: Run tests to verify they fail**

```bash
pnpm --filter @studio-foundation/cli test config
```
Expected: FAIL — the new tests fail (function signature not updated yet)

**Step 3: Update `cli/src/config.ts`**

```typescript
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import yaml from 'js-yaml';
import { findStudioDir } from './studio-dir.js';

export interface StudioConfig {
  providers?: {
    openai?: { apiKey: string };
    anthropic?: { apiKey: string };
  };
  paths?: {
    configs?: string;
    projects_dir?: string;
  };
  defaults?: {
    provider?: string;
    model?: string;
  };
  /** Resolved path to .studio/ dir — set at load time, not from YAML */
  resolvedStudioDir?: string;
}

const LEGACY_CONFIG_NAMES = ['.studiorc.yaml', '.studiorc.yml'];

export async function loadConfig(configPath?: string, cwd?: string): Promise<StudioConfig> {
  const effectiveCwd = cwd ?? process.cwd();

  if (configPath) {
    return loadFromFile(resolve(configPath));
  }

  // 1. Try .studio/config.yaml (new standard)
  const studioDir = await findStudioDir(effectiveCwd);
  if (studioDir) {
    const studioConfig = join(studioDir, 'config.yaml');
    try {
      const config = await loadFromFile(studioConfig);
      config.resolvedStudioDir = studioDir;
      return config;
    } catch {
      // .studio/ exists but no config.yaml — still set studioDir for path resolution
      const empty: StudioConfig = { resolvedStudioDir: studioDir };
      return empty;
    }
  }

  // 2. Fallback: .studiorc.yaml / .studiorc.yml at cwd
  for (const name of LEGACY_CONFIG_NAMES) {
    const filePath = resolve(effectiveCwd, name);
    try {
      return await loadFromFile(filePath);
    } catch {
      // try next
    }
  }

  return {};
}

async function loadFromFile(filePath: string): Promise<StudioConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`Config file not found: ${filePath}`);
  }

  const resolved = resolveEnvVars(raw);

  let parsed: unknown;
  try {
    parsed = yaml.load(resolved);
  } catch (err) {
    throw new Error(
      `Failed to parse config ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    return {};
  }

  return parsed as StudioConfig;
}

export function resolveEnvVars(content: string): string {
  return content.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const value = process.env[varName.trim()];
    return value === undefined ? '' : value;
  });
}
```

**Step 4: Update old tests** — the existing tests pass an explicit `configPath`, which still works. The one test that calls `loadConfig()` with no args searches cwd (which won't find `.studio/` in the test env, so it falls through to legacy search, then returns `{}`). All should still pass.

**Step 5: Run all config tests**

```bash
pnpm --filter @studio-foundation/cli test config
```
Expected: PASS (all tests including the 3 new ones)

**Step 6: Commit**

```bash
git add cli/src/config.ts cli/tests/config.test.ts
git commit -m "feat(cli): load config from .studio/config.yaml with .studiorc.yaml fallback"
```

---

## Task 3: Update `run.ts` and `list.ts` to default to `.studio/projects/`

**Files:**
- Modify: `cli/src/commands/run.ts` (line ~217)
- Modify: `cli/src/commands/list.ts` (line ~21)

### What Changes

Both commands currently do:
```typescript
const configsDir = resolve(config.paths?.configs || './configs');
```

Change to use `resolvedStudioDir` when available:
```typescript
function resolveConfigsDir(config: StudioConfig): string {
  if (config.paths?.configs) return resolve(config.paths.configs);
  if (config.resolvedStudioDir) return resolve(config.resolvedStudioDir, 'projects');
  return resolve('./configs'); // legacy fallback
}
```

No new tests needed — existing tests use mock provider and don't exercise configsDir resolution. Just ensure `pnpm test` still passes.

**Step 1: Add helper to both files**

In `cli/src/commands/run.ts`, replace line 217:
```typescript
// Before:
const configsDir = resolve(config.paths?.configs || './configs');

// After:
const configsDir = config.paths?.configs
  ? resolve(config.paths.configs)
  : config.resolvedStudioDir
    ? resolve(config.resolvedStudioDir, 'projects')
    : resolve('./configs');
```

Same change in `cli/src/commands/list.ts`, line 21.

**Step 2: Run tests**

```bash
pnpm --filter @studio-foundation/cli test
```
Expected: PASS (all existing tests)

**Step 3: Commit**

```bash
git add cli/src/commands/run.ts cli/src/commands/list.ts
git commit -m "feat(cli): default configs dir to .studio/projects/ when .studio/ found"
```

---

## Task 4: `studio config` command

**Files:**
- Create: `cli/src/commands/config.ts`
- Create: `cli/tests/commands/config.test.ts`
- Modify: `cli/src/index.ts`

### Subcommands

```
studio config list                             # print all config (mask API keys)
studio config get <dotted.path>                # get one value
studio config set <dotted.path> <value>        # set by dotted path
studio config set provider <name> --api-key <key>  # convenience for providers.<name>.apiKey
```

Config file to write: `.studio/config.yaml` (found via `findStudioDir`, or create at cwd/.studio/config.yaml).

### Mask rule for `list`: any key named `apiKey` (case-insensitive) → show `sk-***...` (first 3 chars + `***`)

**Step 1: Write failing tests**

```typescript
// cli/tests/commands/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { getConfigValue, setConfigValue, maskSecrets } from '../../src/commands/config.js';

const TMP = resolve(import.meta.dirname, '.tmp-config-cmd-test');
const STUDIO_DIR = resolve(TMP, '.studio');
const CONFIG_FILE = resolve(STUDIO_DIR, 'config.yaml');

beforeEach(async () => { await mkdir(STUDIO_DIR, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

describe('getConfigValue', () => {
  it('gets a nested value by dotted path', () => {
    const config = { defaults: { model: 'claude-haiku' } };
    expect(getConfigValue(config, 'defaults.model')).toBe('claude-haiku');
  });

  it('returns undefined for missing path', () => {
    expect(getConfigValue({}, 'defaults.model')).toBeUndefined();
  });
});

describe('setConfigValue', () => {
  it('sets a nested value by dotted path', () => {
    const config: Record<string, unknown> = {};
    setConfigValue(config, 'defaults.model', 'claude-sonnet');
    expect((config as any).defaults.model).toBe('claude-sonnet');
  });

  it('merges without destroying sibling keys', () => {
    const config = { defaults: { provider: 'anthropic', model: 'old' } };
    setConfigValue(config, 'defaults.model', 'new');
    expect((config as any).defaults.provider).toBe('anthropic');
    expect((config as any).defaults.model).toBe('new');
  });
});

describe('maskSecrets', () => {
  it('masks apiKey values', () => {
    const config = { providers: { anthropic: { apiKey: 'sk-ant-longkey' } } };
    const masked = maskSecrets(config);
    expect((masked as any).providers.anthropic.apiKey).toMatch(/\*\*\*/);
    expect((masked as any).providers.anthropic.apiKey).not.toContain('longkey');
  });

  it('preserves non-secret values', () => {
    const config = { defaults: { model: 'claude-haiku' } };
    expect((maskSecrets(config) as any).defaults.model).toBe('claude-haiku');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
pnpm --filter @studio-foundation/cli test commands/config
```
Expected: FAIL

**Step 3: Implement `cli/src/commands/config.ts`**

```typescript
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import * as yaml from 'js-yaml';
import chalk from 'chalk';
import { findStudioDir } from '../studio-dir.js';
import { resolveEnvVars } from '../config.js';

export function getConfigValue(config: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = config;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function setConfigValue(config: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split('.');
  let current = config;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

export function maskSecrets(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(maskSecrets);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => {
        if (k.toLowerCase() === 'apikey' && typeof v === 'string') {
          const prefix = v.slice(0, 3);
          return [k, `${prefix}***...`];
        }
        return [k, maskSecrets(v)];
      })
    );
  }
  return obj;
}

async function resolveConfigFilePath(): Promise<string> {
  const studioDir = await findStudioDir(process.cwd());
  if (studioDir) return join(studioDir, 'config.yaml');
  // Create .studio/ at cwd if nothing found
  const newStudioDir = resolve(process.cwd(), '.studio');
  await mkdir(newStudioDir, { recursive: true });
  return join(newStudioDir, 'config.yaml');
}

async function loadRawConfig(configFile: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configFile, 'utf-8');
    const parsed = yaml.load(resolveEnvVars(raw));
    return (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function saveConfig(configFile: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, yaml.dump(config), 'utf-8');
}

interface ConfigOptions {
  apiKey?: string;
  project?: string;
}

export async function configCommand(
  action: string,
  args: string[],
  options: ConfigOptions
): Promise<void> {
  try {
    const configFile = await resolveConfigFilePath();

    switch (action) {
      case 'list': {
        const config = await loadRawConfig(configFile);
        const masked = maskSecrets(config);
        console.log('');
        console.log(chalk.bold('Studio Configuration:'));
        console.log(chalk.gray(`  File: ${configFile}`));
        console.log('');
        console.log(yaml.dump(masked));
        break;
      }

      case 'get': {
        const path = args[0];
        if (!path) {
          console.error('Usage: studio config get <dotted.path>');
          process.exit(1);
        }
        const config = await loadRawConfig(configFile);
        const value = getConfigValue(config, path);
        if (value === undefined) {
          console.log(chalk.yellow(`(not set)`));
        } else {
          console.log(String(value));
        }
        break;
      }

      case 'set': {
        const config = await loadRawConfig(configFile);

        // Convenience: studio config set provider <name> --api-key <key>
        if (args[0] === 'provider' && args[1] && options.apiKey) {
          const providerName = args[1];
          setConfigValue(config, `providers.${providerName}.apiKey`, options.apiKey);
          await saveConfig(configFile, config);
          console.log(chalk.green(`✓ Set providers.${providerName}.apiKey`));
          break;
        }

        // Generic: studio config set <dotted.path> <value>
        const path = args[0];
        const value = args[1];
        if (!path || value === undefined) {
          console.error('Usage: studio config set <dotted.path> <value>');
          console.error('       studio config set provider <name> --api-key <key>');
          process.exit(1);
        }
        setConfigValue(config, path, value);
        await saveConfig(configFile, config);
        console.log(chalk.green(`✓ Set ${path} = ${value}`));
        break;
      }

      default:
        console.error(`Unknown config action: ${action}. Available: list, get, set`);
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
```

**Step 4: Register the command in `cli/src/index.ts`**

Add after the existing imports:
```typescript
import { configCommand } from './commands/config.js';
```

Add the command registration before `program.parse()`:
```typescript
program
  .command('config <action> [args...]')
  .description('Manage Studio configuration (list, get, set)')
  .option('--api-key <key>', 'API key (used with: config set provider <name> --api-key <key>)')
  .action(configCommand);
```

**Step 5: Run tests**

```bash
pnpm --filter @studio-foundation/cli test commands/config
```
Expected: PASS

**Step 6: Build and smoke test**

```bash
pnpm build
node cli/dist/index.js config list
node cli/dist/index.js config set defaults.model claude-haiku-4-5-20251001
node cli/dist/index.js config get defaults.model
```

**Step 7: Commit**

```bash
git add cli/src/commands/config.ts cli/tests/commands/config.test.ts cli/src/index.ts
git commit -m "feat(cli): add studio config set/get/list with .studio/config.yaml"
```

---

## Task 5: `studio tools` command

**Files:**
- Create: `cli/src/commands/tools.ts`
- Create: `cli/tests/commands/tools.test.ts`
- Create: `cli/templates/tools/` directory with built-in tool templates
- Modify: `cli/src/index.ts`

### What tools does Studio ship with?

Built-in tools are YAML templates bundled in `cli/templates/tools/`. For v1, ship:
- `repo-manager.tool.yaml` — the repo_manager built-in (already in runner)
- `shell.tool.yaml` — the shell built-in
- `search.tool.yaml` — the search built-in

`studio tools add <name>` copies the template into `.studio/projects/<project>/tools/`.

### Subcommands

```
studio tools list [--project <name>]           # list installed tools
studio tools add <name> --project <project>    # install built-in tool
studio tools remove <name> --project <project> # delete tool yaml
studio tools info <name> --project <project>   # show tool yaml content
```

**Step 1: Create tool templates**

Create `cli/templates/tools/repo-manager.tool.yaml`:
```yaml
name: repo_manager
description: Read and write files in the workspace
builtin: true
tools:
  - name: repo_manager-read_file
    description: Read a file from the workspace
  - name: repo_manager-write_file
    description: Write or create a file in the workspace
  - name: repo_manager-list_files
    description: List files in the workspace
```

Create `cli/templates/tools/shell.tool.yaml`:
```yaml
name: shell
description: Execute shell commands in the workspace
builtin: true
tools:
  - name: shell-run_command
    description: Run a shell command
```

Create `cli/templates/tools/search.tool.yaml`:
```yaml
name: search
description: Search the codebase
builtin: true
tools:
  - name: search-search_codebase
    description: Search files by content or name
```

**Step 2: Write failing tests**

```typescript
// cli/tests/commands/tools.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { listTools, getToolsDir } from '../../src/commands/tools.js';

const TMP = resolve(import.meta.dirname, '.tmp-tools-test');
const STUDIO_DIR = resolve(TMP, '.studio');

beforeEach(async () => { await mkdir(STUDIO_DIR, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

describe('listTools', () => {
  it('returns empty array when no tools dir', async () => {
    const result = await listTools(resolve(STUDIO_DIR, 'projects', 'myproject', 'tools'));
    expect(result).toEqual([]);
  });

  it('finds .tool.yaml files', async () => {
    const toolsDir = resolve(STUDIO_DIR, 'projects', 'myproject', 'tools');
    await mkdir(toolsDir, { recursive: true });
    await writeFile(resolve(toolsDir, 'git.tool.yaml'), 'name: git\n');
    await writeFile(resolve(toolsDir, 'other.txt'), 'ignored\n');
    const result = await listTools(toolsDir);
    expect(result).toEqual(['git']);
  });
});

describe('getToolsDir', () => {
  it('resolves tools dir from studioDir and project', () => {
    const dir = getToolsDir(STUDIO_DIR, 'software');
    expect(dir).toBe(resolve(STUDIO_DIR, 'projects', 'software', 'tools'));
  });
});
```

**Step 3: Run tests to verify they fail**

```bash
pnpm --filter @studio-foundation/cli test commands/tools
```
Expected: FAIL

**Step 4: Implement `cli/src/commands/tools.ts`**

```typescript
import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { resolve, join, dirname, fileURLToPath } from 'node:path';
import chalk from 'chalk';
import { findStudioDir } from '../studio-dir.js';
import { loadConfig } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_TEMPLATES_DIR = resolve(__dirname, '../../templates/tools');

export function getToolsDir(studioDir: string, project: string): string {
  return resolve(studioDir, 'projects', project, 'tools');
}

export async function listTools(toolsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(toolsDir);
    return entries
      .filter((f) => f.endsWith('.tool.yaml'))
      .map((f) => f.replace('.tool.yaml', ''))
      .sort();
  } catch {
    return [];
  }
}

async function resolveProjectToolsDir(projectName?: string): Promise<{ toolsDir: string; project: string }> {
  const config = await loadConfig();
  const studioDir = config.resolvedStudioDir;

  if (!studioDir) {
    console.error('Error: No .studio/ directory found. Run studio init first.');
    process.exit(1);
  }

  // Discover project name if not provided
  let project = projectName;
  if (!project) {
    const projectsDir = resolve(studioDir, 'projects');
    try {
      const entries = await readdir(projectsDir, { withFileTypes: true });
      const projects = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      if (projects.length === 1) {
        project = projects[0]!;
      } else if (projects.length === 0) {
        console.error('Error: No projects found in .studio/projects/. Create one first.');
        process.exit(1);
      } else {
        console.error(`Error: Multiple projects found. Specify one with --project <name>: ${projects.join(', ')}`);
        process.exit(1);
      }
    } catch {
      console.error('Error: Cannot read .studio/projects/');
      process.exit(1);
    }
  }

  return { toolsDir: getToolsDir(studioDir, project!), project: project! };
}

interface ToolsOptions {
  project?: string;
}

export async function toolsCommand(action: string, args: string[], options: ToolsOptions): Promise<void> {
  try {
    switch (action) {
      case 'list': {
        const { toolsDir, project } = await resolveProjectToolsDir(options.project);
        const tools = await listTools(toolsDir);

        if (tools.length === 0) {
          console.log(chalk.yellow(`No tools installed for project '${project}'`));
          console.log(`  Run: studio tools add <name> --project ${project}`);
        } else {
          console.log(`\nInstalled tools (${project}):`);
          for (const t of tools) {
            console.log(`  - ${t}`);
          }
          console.log('');
        }
        break;
      }

      case 'add': {
        const name = args[0];
        if (!name) {
          console.error('Usage: studio tools add <name> --project <project>');
          process.exit(1);
        }
        const { toolsDir, project } = await resolveProjectToolsDir(options.project);
        await mkdir(toolsDir, { recursive: true });

        const templatePath = resolve(TOOL_TEMPLATES_DIR, `${name}.tool.yaml`);
        let templateContent: string;
        try {
          templateContent = await readFile(templatePath, 'utf-8');
        } catch {
          console.error(`Error: Unknown tool '${name}'. Available: repo-manager, shell, search`);
          process.exit(1);
        }

        const destPath = resolve(toolsDir, `${name}.tool.yaml`);
        await writeFile(destPath, templateContent, 'utf-8');
        console.log(chalk.green(`✓ Added tool '${name}' to project '${project}'`));
        break;
      }

      case 'remove': {
        const name = args[0];
        if (!name) {
          console.error('Usage: studio tools remove <name> --project <project>');
          process.exit(1);
        }
        const { toolsDir, project } = await resolveProjectToolsDir(options.project);
        const toolPath = resolve(toolsDir, `${name}.tool.yaml`);
        try {
          await unlink(toolPath);
          console.log(chalk.green(`✓ Removed tool '${name}' from project '${project}'`));
        } catch {
          console.error(`Error: Tool '${name}' not found in project '${project}'`);
          process.exit(1);
        }
        break;
      }

      case 'info': {
        const name = args[0];
        if (!name) {
          console.error('Usage: studio tools info <name> --project <project>');
          process.exit(1);
        }
        const { toolsDir } = await resolveProjectToolsDir(options.project);
        const toolPath = resolve(toolsDir, `${name}.tool.yaml`);
        try {
          const content = await readFile(toolPath, 'utf-8');
          console.log(content);
        } catch {
          console.error(`Error: Tool '${name}' not found.`);
          process.exit(1);
        }
        break;
      }

      default:
        console.error(`Unknown tools action: ${action}. Available: list, add, remove, info`);
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
```

**Step 5: Register in `cli/src/index.ts`**

```typescript
import { toolsCommand } from './commands/tools.js';

// ...

program
  .command('tools <action> [args...]')
  .description('Manage Studio tools (list, add, remove, info)')
  .option('--project <name>', 'Target project name')
  .action(toolsCommand);
```

**Step 6: Run tests**

```bash
pnpm --filter @studio-foundation/cli test commands/tools
```
Expected: PASS

**Step 7: Build and smoke test**

```bash
pnpm build
node cli/dist/index.js tools list
```

**Step 8: Commit**

```bash
git add cli/src/commands/tools.ts cli/tests/commands/tools.test.ts \
        cli/templates/tools/ cli/src/index.ts
git commit -m "feat(cli): add studio tools list/add/remove/info with .studio/projects/ layout"
```

---

## Task 6: Update `studio init` to create `.studio/` structure

**Files:**
- Modify: `cli/src/commands/init.ts`
- Create: `cli/templates/studio-config.yaml` (template for `.studio/config.yaml`)
- Modify: `cli/tests/commands/init.test.ts` (if it exists) or create it

### What `studio init` should create

```
.studio/
├── config.yaml          ← from template (gitignored)
├── projects/
│   └── default/
│       ├── pipelines/
│       ├── agents/
│       ├── contracts/
│       ├── tools/
│       └── inputs/
└── runs/                ← (gitignored)
```

And add to `.gitignore`:
```
.studio/config.yaml
.studio/runs/
```

**Step 1: Create the config template**

`cli/templates/studio-config.yaml`:
```yaml
# Studio Configuration
# This file is gitignored — it contains secrets.
# See .studio/projects/ for your pipeline configs (those ARE committed).

providers:
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}
  # openai:
  #   apiKey: ${OPENAI_API_KEY}

defaults:
  provider: anthropic
  model: claude-sonnet-4-6
```

**Step 2: Write failing tests**

```typescript
// cli/tests/commands/init.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const TMP = resolve(import.meta.dirname, '.tmp-init-test');

beforeEach(async () => { await mkdir(TMP, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe('initCommand', () => {
  it('creates .studio/ directory structure', async () => {
    // We test the helper functions directly (not the CLI command)
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    expect(await exists(resolve(TMP, '.studio'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'config.yaml'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'pipelines'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'agents'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'contracts'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'tools'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'inputs'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'runs'))).toBe(true);
  });

  it('adds .studio/config.yaml and .studio/runs/ to .gitignore', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    const gitignore = await readFile(resolve(TMP, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.studio/config.yaml');
    expect(gitignore).toContain('.studio/runs/');
  });

  it('appends to existing .gitignore without duplicating', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    // Create existing .gitignore with some content
    const gitignorePath = resolve(TMP, '.gitignore');
    await writeFile(gitignorePath, 'node_modules/\n.studio/config.yaml\n');

    // @ts-ignore (imported from test file)
    const { writeFile } = await import('node:fs/promises');
    await writeFile(gitignorePath, 'node_modules/\n.studio/config.yaml\n');

    await createStudioStructure(TMP);

    const content = await readFile(gitignorePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim() === '.studio/config.yaml');
    expect(lines.length).toBe(1); // no duplicate
  });
});
```

> **Note on the third test:** It's a bit tricky since we're importing `writeFile` from `node:fs/promises` inside the test. Simplify if needed — the key is no duplicate gitignore entries.

**Step 3: Run tests to verify they fail**

```bash
pnpm --filter @studio-foundation/cli test commands/init
```
Expected: FAIL — `createStudioStructure` not exported

**Step 4: Rewrite `cli/src/commands/init.ts`**

```typescript
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, '../../templates');

const GITIGNORE_ENTRIES = [
  '.studio/config.yaml',
  '.studio/runs/',
];

const PROJECT_SUBDIRS = ['pipelines', 'agents', 'contracts', 'tools', 'inputs'];

export async function createStudioStructure(cwd: string): Promise<void> {
  const studioDir = resolve(cwd, '.studio');
  const projectDir = join(studioDir, 'projects', 'default');

  // Create directory structure
  for (const sub of PROJECT_SUBDIRS) {
    await mkdir(join(projectDir, sub), { recursive: true });
  }
  await mkdir(join(studioDir, 'runs'), { recursive: true });

  // Copy config template (only if config.yaml doesn't already exist)
  const configPath = join(studioDir, 'config.yaml');
  const configExists = await access(configPath).then(() => true).catch(() => false);
  if (!configExists) {
    const template = await readFile(resolve(TEMPLATES_DIR, 'studio-config.yaml'), 'utf-8');
    await writeFile(configPath, template, 'utf-8');
  }

  // Update .gitignore
  await updateGitignore(cwd);
}

async function updateGitignore(cwd: string): Promise<void> {
  const gitignorePath = resolve(cwd, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(gitignorePath, 'utf-8');
  } catch {
    // file doesn't exist yet
  }

  const toAdd = GITIGNORE_ENTRIES.filter((entry) => !existing.includes(entry));
  if (toAdd.length === 0) return;

  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const addition = '\n# Studio (generated)\n' + toAdd.join('\n') + '\n';
  await writeFile(gitignorePath, existing + separator + addition, 'utf-8');
}

export async function initCommand(): Promise<void> {
  try {
    const cwd = process.cwd();

    console.log(chalk.blue('\nInitializing Studio project...\n'));

    await createStudioStructure(cwd);

    console.log(chalk.gray('  Created .studio/config.yaml'));
    console.log(chalk.gray('  Created .studio/projects/default/{pipelines,agents,contracts,tools,inputs}/'));
    console.log(chalk.gray('  Created .studio/runs/'));
    console.log(chalk.gray('  Updated .gitignore'));
    console.log(chalk.green('\n✓ Studio project initialized'));
    console.log('');
    console.log('Next steps:');
    console.log(`  1. Set your API key: ${chalk.cyan('export ANTHROPIC_API_KEY=...')}`);
    console.log(`  2. Or: ${chalk.cyan('studio config set provider anthropic --api-key $ANTHROPIC_API_KEY')}`);
    console.log(`  3. Add your pipeline configs to: ${chalk.cyan('.studio/projects/default/')}`);
    console.log(`  4. Run: ${chalk.cyan('studio run default/my-pipeline --input "Hello!"')}`);
    console.log('');
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
```

**Step 5: Run tests**

```bash
pnpm --filter @studio-foundation/cli test commands/init
```
Expected: PASS

**Step 6: Commit**

```bash
git add cli/src/commands/init.ts cli/templates/studio-config.yaml cli/tests/commands/init.test.ts
git commit -m "feat(cli): studio init creates .studio/ structure with .gitignore entries"
```

---

## Task 7: Full build + test suite + PR

**Step 1: Run the full test suite**

```bash
pnpm test
```
Expected: All tests pass across all packages.

**Step 2: Build everything**

```bash
pnpm build
```
Expected: No TypeScript errors.

**Step 3: Smoke test end-to-end**

```bash
# From a temp directory:
mkdir /tmp/test-studio && cd /tmp/test-studio
node /path/to/Studio/cli/dist/index.js init
cat .studio/config.yaml
cat .gitignore
node /path/to/Studio/cli/dist/index.js config set provider anthropic --api-key sk-test
node /path/to/Studio/cli/dist/index.js config list
node /path/to/Studio/cli/dist/index.js tools list
```

**Step 4: Push and create PR**

```bash
git push -u origin feat/stu-35-studio-dir-migration
gh pr create \
  --title "feat(cli): STU-35 — .studio/ migration, studio config + studio tools" \
  --body "$(cat <<'EOF'
## What

Implements STU-35: moves Studio config from `.studiorc.yaml` into `.studio/config.yaml`, project configs default to `.studio/projects/`, and adds `studio config` and `studio tools` subcommands.

## Packages touched

- `@studio-foundation/cli` — all changes live here

## Changes

- `cli/src/studio-dir.ts` — `findStudioDir()` walks up the tree for `.studio/`
- `cli/src/config.ts` — loads `.studio/config.yaml`, falls back to `.studiorc.yaml`
- `cli/src/commands/run.ts`, `list.ts` — default configs dir to `.studio/projects/`
- `cli/src/commands/config.ts` — `studio config set/get/list`
- `cli/src/commands/tools.ts` — `studio tools list/add/remove/info`
- `cli/src/commands/init.ts` — rewrote to create `.studio/` structure
- `cli/templates/studio-config.yaml` — new config template
- `cli/templates/tools/` — built-in tool templates

## Acceptance criteria covered

- [x] `findStudioDir()` walks up the directory tree
- [x] Engine loads configs from `.studio/projects/` (via configsDir default)
- [x] `config.yaml` replaces `.studiorc.yaml` (with backward compat)
- [x] `studio config set/get/list` functional
- [x] `studio tools list/add/remove` functional
- [x] Runs already in `.studio/runs/` (was done)
- [x] `studio init` creates `.studio/` complete structure
- [x] `.gitignore` entries added automatically
- [x] Backward compat: falls back to `.studiorc.yaml` if no `.studio/`
- [x] API keys masked in `studio config list`

## How to test

```bash
pnpm test
mkdir /tmp/test-studio-stu35 && cd /tmp/test-studio-stu35
studio init
studio config set provider anthropic --api-key sk-test
studio config list
studio tools list
```
EOF
)"
```

---

## Acceptance Criteria Checklist

- [ ] `findStudioDir()` implémenté — Task 1
- [ ] Engine charge configs depuis `.studio/projects/` — Task 3
- [ ] `config.yaml` remplace `.studiorc.yaml` — Task 2
- [ ] `studio config set/get/list` fonctionnel — Task 4
- [ ] `studio tools list/add/remove` fonctionnel — Task 5
- [ ] Runs stockés dans `.studio/runs/` — ALREADY DONE ✓
- [ ] `studio init` crée la structure `.studio/` complète — Task 6
- [ ] `.gitignore` entries ajoutées automatiquement par init — Task 6
- [ ] Backward compat fallback — Task 2
- [ ] API keys masquées dans `studio config list` — Task 4
