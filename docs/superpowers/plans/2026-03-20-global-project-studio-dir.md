# Global vs Project `.studio/` separation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate `~/.studio/` (global config) from `.studio/` (project config) so that a global Studio install doesn't block project-level `studio init` and commands.

**Architecture:** Add `findProjectStudioDir` (stops before `$HOME`) and `findGlobalStudioDir` (returns `~/.studio/`) to `studio-dir.ts`. Update `loadConfig` to load both and deep-merge them (global base, project override). Keep `findStudioDir` as a `@deprecated` alias.

**Tech Stack:** TypeScript, Node.js `fs/promises`, `os.homedir()`, vitest

**Spec:** `docs/superpowers/specs/2026-03-20-global-project-studio-dir-design.md`

---

## Files

| File | Action | Responsibility |
|------|--------|----------------|
| `cli/src/studio-dir.ts` | Modify | Add `findProjectStudioDir`, `findGlobalStudioDir`; deprecate `findStudioDir` |
| `cli/src/config.ts` | Modify | Update `loadConfig` to merge global + project |
| `cli/tests/studio-dir.test.ts` | Modify | Add tests for new functions |
| `cli/tests/config.test.ts` | Modify | Add merge tests, isolate existing tests from real `~/.studio/` |

---

## Task 1: `findProjectStudioDir` + `findGlobalStudioDir` in `studio-dir.ts`

**Files:**
- Modify: `cli/src/studio-dir.ts`
- Modify: `cli/tests/studio-dir.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the content of `cli/tests/studio-dir.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import os from 'node:os';

const TMP = resolve('/tmp', '.studio-dir-test-' + Date.now());

beforeEach(async () => { await mkdir(TMP, { recursive: true }); });
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// --- findStudioDir (legacy alias, keep working) ---
describe('findStudioDir', () => {
  it('finds .studio/ in the given directory', async () => {
    const { findStudioDir } = await import('../src/studio-dir.js');
    await mkdir(resolve(TMP, '.studio'), { recursive: true });
    const result = await findStudioDir(TMP);
    expect(result).toBe(resolve(TMP, '.studio'));
  });

  it('finds .studio/ in a parent directory', async () => {
    const { findStudioDir } = await import('../src/studio-dir.js');
    await mkdir(resolve(TMP, '.studio'), { recursive: true });
    const nested = resolve(TMP, 'a', 'b', 'c');
    await mkdir(nested, { recursive: true });
    const result = await findStudioDir(nested);
    expect(result).toBe(resolve(TMP, '.studio'));
  });

  it('returns null when .studio/ is not found', async () => {
    const { findStudioDir } = await import('../src/studio-dir.js');
    const result = await findStudioDir('/');
    expect(result).toBeNull();
  });
});

// --- findProjectStudioDir ---
describe('findProjectStudioDir', () => {
  it('finds .studio/ in the given directory', async () => {
    const { findProjectStudioDir } = await import('../src/studio-dir.js');
    await mkdir(resolve(TMP, '.studio'), { recursive: true });
    const result = await findProjectStudioDir(TMP);
    expect(result).toBe(resolve(TMP, '.studio'));
  });

  it('finds .studio/ in a parent directory', async () => {
    const { findProjectStudioDir } = await import('../src/studio-dir.js');
    await mkdir(resolve(TMP, '.studio'), { recursive: true });
    const nested = resolve(TMP, 'a', 'b', 'c');
    await mkdir(nested, { recursive: true });
    const result = await findProjectStudioDir(nested);
    expect(result).toBe(resolve(TMP, '.studio'));
  });

  it('returns null when .studio/ is not found', async () => {
    const { findProjectStudioDir } = await import('../src/studio-dir.js');
    const result = await findProjectStudioDir('/');
    expect(result).toBeNull();
  });

  it('stops before $HOME — never returns ~/.studio/', async () => {
    // Simulate: startDir is inside a fake $HOME that has .studio/ at its root.
    // We mock os.homedir() to return a fake home, then start from a subdir of it
    // that has no .studio/. The function must NOT walk up and return fakeHome/.studio/.
    const fakeHome = resolve(TMP, 'fake-home');
    const fakeProject = resolve(fakeHome, 'some-subdir');
    await mkdir(resolve(fakeHome, '.studio'), { recursive: true }); // ~/.studio/ exists
    await mkdir(fakeProject, { recursive: true });                   // project dir, no .studio/

    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    // Re-import to pick up the mock (studio-dir.ts calls os.homedir() at runtime)
    vi.resetModules();
    const { findProjectStudioDir } = await import('../src/studio-dir.js');

    const result = await findProjectStudioDir(fakeProject);
    expect(result).toBeNull(); // Must NOT return fakeHome/.studio/
  });

  it('finds .studio/ in a project directly under $HOME (e.g. ~/my-project)', async () => {
    // ~/my-project/.studio/ must be found when starting from ~/my-project/src/,
    // because ~/my-project !== ~/. Only $HOME itself is excluded.
    const fakeHome = resolve(TMP, 'fake-home');
    const projectRoot = resolve(fakeHome, 'my-project');
    const src = resolve(projectRoot, 'src');
    await mkdir(resolve(projectRoot, '.studio'), { recursive: true });
    await mkdir(src, { recursive: true });

    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    vi.resetModules();
    const { findProjectStudioDir } = await import('../src/studio-dir.js');

    const result = await findProjectStudioDir(src);
    expect(result).toBe(resolve(projectRoot, '.studio'));
  });
});

// --- findGlobalStudioDir ---
describe('findGlobalStudioDir', () => {
  it('returns ~/.studio/ when it exists', async () => {
    const fakeHome = resolve(TMP, 'fake-home-global');
    const fakeStudio = resolve(fakeHome, '.studio');
    await mkdir(fakeStudio, { recursive: true });

    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    vi.resetModules();
    const { findGlobalStudioDir } = await import('../src/studio-dir.js');

    const result = await findGlobalStudioDir();
    expect(result).toBe(fakeStudio);
  });

  it('returns null when ~/.studio/ does not exist', async () => {
    const fakeHome = resolve(TMP, 'fake-home-empty');
    await mkdir(fakeHome, { recursive: true }); // no .studio/ inside

    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    vi.resetModules();
    const { findGlobalStudioDir } = await import('../src/studio-dir.js');

    const result = await findGlobalStudioDir();
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd cli && pnpm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|PASS|findProjectStudioDir|findGlobalStudioDir)"
```

Expected: Tests for `findProjectStudioDir` and `findGlobalStudioDir` fail with "not a function" or similar.

- [ ] **Step 3: Implement `findProjectStudioDir` and `findGlobalStudioDir`**

Replace `cli/src/studio-dir.ts` with:

```typescript
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';

/**
 * Walk up from startDir looking for .studio/, stopping BEFORE os.homedir().
 * Returns the absolute path to the project's .studio/, or null if not found.
 *
 * ~/ itself is never checked — so ~/.studio/ is never returned by this function.
 * A project at ~/my-project/.studio/ IS found when starting from ~/my-project/src/,
 * because ~/my-project !== ~/. Only $HOME itself is excluded.
 */
export async function findProjectStudioDir(startDir: string): Promise<string | null> {
  const home = os.homedir();
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
    if (parent === current || current === home) {
      // Reached filesystem root or $HOME — stop
      return null;
    }
    current = parent;
  }
}

/**
 * Returns the absolute path to ~/.studio/ if it exists, null otherwise.
 * This is the global config location — API keys, default provider.
 */
export async function findGlobalStudioDir(): Promise<string | null> {
  const candidate = join(os.homedir(), '.studio');
  try {
    await access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * @deprecated Use findProjectStudioDir instead.
 * Kept for backwards compatibility during transition.
 */
export async function findStudioDir(startDir: string): Promise<string | null> {
  return findProjectStudioDir(startDir);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd cli && pnpm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|PASS|studio-dir)"
```

Expected: All tests in `studio-dir.test.ts` pass.

- [ ] **Step 5: Commit**

```bash
git add cli/src/studio-dir.ts cli/tests/studio-dir.test.ts
git commit -m "feat(cli): add findProjectStudioDir + findGlobalStudioDir — stop before \$HOME"
```

---

## Task 2: Update `loadConfig` to merge global + project

**Files:**
- Modify: `cli/src/config.ts`
- Modify: `cli/tests/config.test.ts`

- [ ] **Step 1: Update the legacy fallback mock in the existing test**

In `cli/tests/config.test.ts`, find the test `'should fall back to .studiorc.yaml when no .studio/'`.
The `vi.doMock` call currently only mocks `findStudioDir`. Update it to also mock the new functions:

```typescript
vi.doMock('../src/studio-dir.js', () => ({
  findStudioDir: vi.fn().mockResolvedValue(null),
  findProjectStudioDir: vi.fn().mockResolvedValue(null),
  findGlobalStudioDir: vi.fn().mockResolvedValue(null),
}));
```

Also update the existing test `'should load .studio/config.yaml when present'` to pass a `globalStudioDir` option to keep it isolated from any real `~/.studio/` on the machine:

```typescript
// Before (line 84):
const config = await loadConfig(undefined, TEST_DIR);

// After:
const config = await loadConfig(undefined, TEST_DIR, {
  globalStudioDir: resolve('/tmp', 'nonexistent-global-' + Date.now()),
});
```

- [ ] **Step 2: Add the new merge tests**

Add these test cases inside the `describe('loadConfig', ...)` block in `cli/tests/config.test.ts`, before the closing `}`:

```typescript
  it('merges global and project config — project wins on shared keys', async () => {
    const fakeGlobal = resolve('/tmp', `.studio-global-${Date.now()}`);
    await mkdir(fakeGlobal, { recursive: true });
    await writeFile(resolve(fakeGlobal, 'config.yaml'), [
      'providers:',
      '  anthropic:',
      '    apiKey: global-key',
      '  openai:',
      '    apiKey: global-openai-key',
      'defaults:',
      '  provider: anthropic',
      '  model: claude-haiku-4-20250514',
    ].join('\n'));

    const studioDir = resolve(TEST_DIR, '.studio');
    await mkdir(studioDir, { recursive: true });
    await writeFile(resolve(studioDir, 'config.yaml'), [
      'defaults:',
      '  provider: openai',
      '  model: gpt-4o',
    ].join('\n'));

    const config = await loadConfig(undefined, TEST_DIR, { globalStudioDir: fakeGlobal });

    expect(config.defaults?.provider).toBe('openai');
    expect(config.defaults?.model).toBe('gpt-4o');
    expect(config.providers?.anthropic?.apiKey).toBe('global-key');
    expect(config.providers?.openai?.apiKey).toBe('global-openai-key');
    expect(config.resolvedStudioDir).toBe(studioDir);

    await rm(fakeGlobal, { recursive: true, force: true });
  });

  it('returns global config when no project .studio/ exists', async () => {
    const fakeGlobal = resolve('/tmp', `.studio-global-${Date.now()}`);
    await mkdir(fakeGlobal, { recursive: true });
    await writeFile(resolve(fakeGlobal, 'config.yaml'), [
      'providers:',
      '  anthropic:',
      '    apiKey: global-only-key',
      'defaults:',
      '  provider: anthropic',
    ].join('\n'));

    const config = await loadConfig(undefined, TEST_DIR, { globalStudioDir: fakeGlobal });

    expect(config.providers?.anthropic?.apiKey).toBe('global-only-key');
    expect(config.resolvedStudioDir).toBe(fakeGlobal);

    await rm(fakeGlobal, { recursive: true, force: true });
  });

  it('returns project config when no global config exists', async () => {
    const studioDir = resolve(TEST_DIR, '.studio');
    await mkdir(studioDir, { recursive: true });
    await writeFile(resolve(studioDir, 'config.yaml'), [
      'providers:',
      '  anthropic:',
      '    apiKey: project-only-key',
    ].join('\n'));

    const config = await loadConfig(undefined, TEST_DIR, {
      globalStudioDir: resolve('/tmp', 'nonexistent-global-' + Date.now()),
    });

    expect(config.providers?.anthropic?.apiKey).toBe('project-only-key');
    expect(config.resolvedStudioDir).toBe(studioDir);
  });

  it('project provider object entirely replaces global provider (shallow merge)', async () => {
    const fakeGlobal = resolve('/tmp', `.studio-global-${Date.now()}`);
    await mkdir(fakeGlobal, { recursive: true });
    await writeFile(resolve(fakeGlobal, 'config.yaml'), [
      'providers:',
      '  anthropic:',
      '    apiKey: global-anthropic-key',
    ].join('\n'));

    const studioDir = resolve(TEST_DIR, '.studio');
    await mkdir(studioDir, { recursive: true });
    await writeFile(resolve(studioDir, 'config.yaml'), [
      'providers:',
      '  anthropic:',
      '    apiKey: project-anthropic-key',
    ].join('\n'));

    const config = await loadConfig(undefined, TEST_DIR, { globalStudioDir: fakeGlobal });

    expect(config.providers?.anthropic?.apiKey).toBe('project-anthropic-key');

    await rm(fakeGlobal, { recursive: true, force: true });
  });
```

- [ ] **Step 3: Run tests to verify new ones fail, existing ones still pass**

```bash
cd cli && pnpm test -- --reporter=verbose 2>&1 | tail -30
```

Expected: New merge tests fail (loadConfig signature unchanged yet). Existing tests should all still pass.

- [ ] **Step 4: Implement the merge logic in `loadConfig`**

Replace `cli/src/config.ts` with:

```typescript
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import yaml from 'js-yaml';
import { findProjectStudioDir, findGlobalStudioDir } from './studio-dir.js';

export interface StudioConfig {
  providers?: {
    openai?: { apiKey: string };
    anthropic?: { apiKey: string };
    ollama?: { baseUrl?: string };
  };
  paths?: {
    configs?: string;
    projects_dir?: string;
    pipelines?: string;
  };
  defaults?: {
    provider?: string;
    model?: string;
  };
  api?: {
    key?: string;
    port?: number;
  };
  integrations?: Record<string, Record<string, unknown>>;
  db?: {
    type?: 'sqlite' | 'postgres' | 'inmemory';
    url?: string;
  };
  /** Resolved path to .studio/ dir — set at load time, not from YAML */
  resolvedStudioDir?: string;
}

export interface LoadConfigOptions {
  /** Override the global studio dir (used in tests). Defaults to findGlobalStudioDir(). */
  globalStudioDir?: string;
}

const LEGACY_CONFIG_NAMES = ['.studiorc.yaml', '.studiorc.yml'];

export async function loadConfig(
  configPath?: string,
  cwd?: string,
  options: LoadConfigOptions = {}
): Promise<StudioConfig> {
  const effectiveCwd = cwd ?? process.cwd();

  // Explicit path short-circuits everything
  if (configPath) {
    return loadFromFile(resolve(configPath));
  }

  // 1. Load global config (~/.studio/config.yaml)
  const globalDir = options.globalStudioDir ?? (await findGlobalStudioDir());
  let globalConfig: StudioConfig = {};
  if (globalDir) {
    try {
      globalConfig = await loadFromFile(join(globalDir, 'config.yaml'));
    } catch {
      // ~/.studio/ exists but no config.yaml — use empty global
    }
  }

  // 2. Load project config (.studio/config.yaml — stops before $HOME)
  const projectDir = await findProjectStudioDir(effectiveCwd);
  if (projectDir) {
    let projectConfig: StudioConfig = {};
    try {
      projectConfig = await loadFromFile(join(projectDir, 'config.yaml'));
    } catch {
      // .studio/ exists but no config.yaml
    }
    const merged = mergeConfigs(globalConfig, projectConfig);
    merged.resolvedStudioDir = projectDir;
    return merged;
  }

  // 3. Global only (no project .studio/)
  if (globalDir) {
    globalConfig.resolvedStudioDir = globalDir;
    return globalConfig;
  }

  // 4. Fallback: .studiorc.yaml / .studiorc.yml at cwd (legacy)
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

/**
 * Merge global and project configs. Project values override global values.
 * providers and integrations: shallow merge at key level (project key replaces global key).
 * All other fields: project overrides global entirely.
 */
function mergeConfigs(global: StudioConfig, project: StudioConfig): StudioConfig {
  return {
    providers: { ...global.providers, ...project.providers },
    integrations: { ...global.integrations, ...project.integrations },
    defaults: project.defaults ?? global.defaults,
    api: project.api ?? global.api,
    db: project.db ?? global.db,
    paths: project.paths ?? global.paths,
  };
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

- [ ] **Step 5: Run all tests**

```bash
cd cli && pnpm test -- --reporter=verbose 2>&1 | tail -30
```

Expected: All tests pass, including the new merge tests and the existing legacy fallback test.

- [ ] **Step 6: Build to verify TypeScript**

```bash
cd .. && pnpm build 2>&1 | tail -20
```

Expected: Build completes with no errors.

- [ ] **Step 7: Commit**

```bash
git add cli/src/config.ts cli/tests/config.test.ts
git commit -m "feat(cli): loadConfig merges global (~/.studio/) and project (.studio/) configs"
```

---

## Task 3: Verify end-to-end behavior

- [ ] **Step 1: Check that `studio init` in a fresh dir no longer errors**

```bash
cd /tmp && mkdir studio-test-$$ && cd studio-test-$$ && studio init --provider mock 2>&1 | head -5
```

Expected: Wizard starts (or a useful error), NOT "Studio is already initialized at ~/.studio".

- [ ] **Step 2: Verify `studio config list` in a project reads both global + project**

In a project with `.studio/config.yaml` that has only `defaults`, run:

```bash
studio config list
```

Expected: Shows providers from `~/.studio/config.yaml` merged with project defaults.

- [ ] **Step 3: Final commit if anything was adjusted**

```bash
git add -p
git commit -m "fix(cli): end-to-end verification adjustments"
```
