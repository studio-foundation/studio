# STU-202 — Registry Dependency Resolution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement dependency resolution in `studio registry install` — auto-install `required` deps, prompt for `recommended`, track `required_by` in lockfile, and clean up orphans on remove.

**Architecture:** New `cli/src/registry/resolver.ts` module handles the dependency graph resolution (recursive, cycle-detecting). `install.ts` uses the resolver to flatten and install deps in order. `remove.ts` checks `required_by` before removal and offers orphan cleanup. Types extended in `types.ts`, `RegistryLockfile` extended in `lockfile.ts`.

**Tech Stack:** TypeScript, Vitest, Node.js `fs/promises`, `@inquirer/prompts`, existing `RegistryClient`/`RegistryLockfile`/`RegistryCache` classes.

**Design doc:** `docs/plans/2026-02-28-stu-202-registry-dependency-resolution-design.md`

---

## Task 1: Extend Types

**Files:**
- Modify: `cli/src/registry/types.ts`

No test needed — pure type changes. Types are validated by TypeScript compilation.

**Step 1: Add `PackageDependencies` interface and extend `PackageMetadata` and `LockfileEntry`**

In `cli/src/registry/types.ts`, add after the existing `PackageEntry` interface:

```ts
export interface PackageDependencies {
  tools?:     { required?: string[]; recommended?: string[] };
  agents?:    { required?: string[]; recommended?: string[] };
  skills?:    { required?: string[]; recommended?: string[] };
  templates?: { required?: string[]; recommended?: string[] };
  pipelines?: { required?: string[]; recommended?: string[] };
}
```

Extend `PackageMetadata`:
```ts
export interface PackageMetadata extends PackageEntry {
  requires_binaries?: string[];
  dependencies?: PackageDependencies;   // ← add this line
}
```

Extend `LockfileEntry`:
```ts
export interface LockfileEntry {
  version: string;
  type: PackageType;
  installed_at: string;
  sha256: string;
  required_by?: string[];   // ← add this line
}
```

**Step 2: Verify TypeScript compiles**

```bash
cd cli && pnpm typecheck
```

Expected: no errors.

**Step 3: Commit**

```bash
git add cli/src/registry/types.ts
git commit -m "feat(registry): add PackageDependencies type and required_by to LockfileEntry (STU-202)"
```

---

## Task 2: Extend RegistryLockfile with `addRequiredBy`

**Files:**
- Modify: `cli/src/registry/lockfile.ts`
- Test: `cli/tests/registry/lockfile.test.ts` (create new file — check if exists first)

**Step 1: Write the failing test**

Create `cli/tests/registry/lockfile.test.ts` (if it doesn't exist already, otherwise append):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const TMP = resolve(import.meta.dirname, '.tmp-lockfile');
const STUDIO = join(TMP, '.studio');

beforeEach(async () => { await mkdir(STUDIO, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

describe('RegistryLockfile.addRequiredBy', () => {
  it('adds required_by to an existing entry', async () => {
    const { RegistryLockfile } = await import('../../src/registry/lockfile.js');
    const lf = new RegistryLockfile(STUDIO);
    await lf.add('repo-manager', { version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256: 'abc' });

    await lf.addRequiredBy('repo-manager', 'software-full');

    const entry = await lf.get('repo-manager');
    expect(entry?.required_by).toEqual(['software-full']);
  });

  it('does not duplicate if already present', async () => {
    const { RegistryLockfile } = await import('../../src/registry/lockfile.js');
    const lf = new RegistryLockfile(STUDIO);
    await lf.add('repo-manager', { version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256: 'abc', required_by: ['software-full'] });

    await lf.addRequiredBy('repo-manager', 'software-full');

    const entry = await lf.get('repo-manager');
    expect(entry?.required_by).toEqual(['software-full']); // still just one
  });

  it('removes from required_by with removeRequiredBy', async () => {
    const { RegistryLockfile } = await import('../../src/registry/lockfile.js');
    const lf = new RegistryLockfile(STUDIO);
    await lf.add('repo-manager', { version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256: 'abc', required_by: ['software-full', 'other-pkg'] });

    await lf.removeRequiredBy('repo-manager', 'software-full');

    const entry = await lf.get('repo-manager');
    expect(entry?.required_by).toEqual(['other-pkg']);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd cli && pnpm test -- --reporter=verbose tests/registry/lockfile.test.ts
```

Expected: FAIL — `lf.addRequiredBy is not a function`

**Step 3: Implement `addRequiredBy` and `removeRequiredBy` in `lockfile.ts`**

Add these two methods to the `RegistryLockfile` class:

```ts
async addRequiredBy(name: string, requiredBy: string): Promise<void> {
  const data = await this.read();
  const entry = data.installed[name];
  if (!entry) return;
  const existing = entry.required_by ?? [];
  if (!existing.includes(requiredBy)) {
    data.installed[name] = { ...entry, required_by: [...existing, requiredBy] };
    await this.write(data);
  }
}

async removeRequiredBy(name: string, requiredBy: string): Promise<void> {
  const data = await this.read();
  const entry = data.installed[name];
  if (!entry) return;
  data.installed[name] = { ...entry, required_by: (entry.required_by ?? []).filter(r => r !== requiredBy) };
  await this.write(data);
}
```

**Step 4: Run tests to verify they pass**

```bash
cd cli && pnpm test -- --reporter=verbose tests/registry/lockfile.test.ts
```

Expected: all 3 tests PASS.

**Step 5: Commit**

```bash
git add cli/src/registry/lockfile.ts cli/tests/registry/lockfile.test.ts
git commit -m "feat(registry): add addRequiredBy/removeRequiredBy to RegistryLockfile (STU-202)"
```

---

## Task 3: Create `resolver.ts`

**Files:**
- Create: `cli/src/registry/resolver.ts`
- Create: `cli/tests/registry/resolver.test.ts`

**Step 1: Write the failing tests**

Create `cli/tests/registry/resolver.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { RegistryIndex, PackageMetadata, Lockfile } from '../../src/registry/types.js';

// Build a minimal index entry
function indexEntry(name: string, type: string) {
  return { name, type, version: '1.0.0', description: '', author: '', license: 'MIT', tags: [], studio_version: null, downloads: 0 };
}

function meta(name: string, deps?: PackageMetadata['dependencies']): PackageMetadata {
  return { ...indexEntry(name, 'tool'), dependencies: deps };
}

const EMPTY_LOCKFILE: Lockfile = { installed: {} };

const MOCK_FETCH: (name: string) => Promise<PackageMetadata> = async (name) => {
  // Returns metadata with no deps by default — tests override as needed
  return meta(name);
};

describe('resolveDependencies', () => {
  it('returns empty graph when package has no dependencies', async () => {
    const { resolveDependencies } = await import('../../src/registry/resolver.js');
    const index: RegistryIndex = { generated_at: '', version: '1', packages: [] };
    const result = await resolveDependencies('my-pkg', meta('my-pkg'), index, EMPTY_LOCKFILE, MOCK_FETCH);
    expect(result.required).toEqual([]);
    expect(result.recommended).toEqual([]);
  });

  it('resolves required tools from first-level deps', async () => {
    const { resolveDependencies } = await import('../../src/registry/resolver.js');
    const index: RegistryIndex = {
      generated_at: '', version: '1',
      packages: [indexEntry('repo-manager', 'tool'), indexEntry('shell', 'tool')],
    };
    const pkgMeta = meta('software-full', {
      tools: { required: ['repo-manager', 'shell'] },
    });
    const result = await resolveDependencies('software-full', pkgMeta, index, EMPTY_LOCKFILE, MOCK_FETCH);
    expect(result.required.map(d => d.name)).toEqual(expect.arrayContaining(['repo-manager', 'shell']));
    expect(result.required).toHaveLength(2);
    expect(result.recommended).toEqual([]);
  });

  it('returns recommended at first level without recursion', async () => {
    const { resolveDependencies } = await import('../../src/registry/resolver.js');
    const index: RegistryIndex = {
      generated_at: '', version: '1',
      packages: [indexEntry('code-conventions', 'skill')],
    };
    const pkgMeta = meta('software-full', {
      skills: { recommended: ['code-conventions'] },
    });
    const result = await resolveDependencies('software-full', pkgMeta, index, EMPTY_LOCKFILE, MOCK_FETCH);
    expect(result.recommended.map(d => d.name)).toEqual(['code-conventions']);
    expect(result.required).toEqual([]);
  });

  it('resolves required deps recursively (A requires B which requires C)', async () => {
    const { resolveDependencies } = await import('../../src/registry/resolver.js');
    const index: RegistryIndex = {
      generated_at: '', version: '1',
      packages: [
        indexEntry('B', 'tool'),
        indexEntry('C', 'tool'),
      ],
    };
    const fetchMeta: (name: string) => Promise<PackageMetadata> = async (name) => {
      if (name === 'B') return meta('B', { tools: { required: ['C'] } });
      return meta(name);
    };
    const pkgMeta = meta('A', { tools: { required: ['B'] } });
    const result = await resolveDependencies('A', pkgMeta, index, EMPTY_LOCKFILE, fetchMeta);
    expect(result.required.map(d => d.name)).toEqual(expect.arrayContaining(['B', 'C']));
    expect(result.required).toHaveLength(2);
  });

  it('deduplicates when two paths lead to the same dep', async () => {
    const { resolveDependencies } = await import('../../src/registry/resolver.js');
    const index: RegistryIndex = {
      generated_at: '', version: '1',
      packages: [indexEntry('B', 'tool'), indexEntry('C', 'tool'), indexEntry('D', 'tool')],
    };
    // A requires B and C, both require D
    const fetchMeta: (name: string) => Promise<PackageMetadata> = async (name) => {
      if (name === 'B') return meta('B', { tools: { required: ['D'] } });
      if (name === 'C') return meta('C', { tools: { required: ['D'] } });
      return meta(name);
    };
    const pkgMeta = meta('A', { tools: { required: ['B', 'C'] } });
    const result = await resolveDependencies('A', pkgMeta, index, EMPTY_LOCKFILE, fetchMeta);
    const names = result.required.map(d => d.name);
    expect(names.filter(n => n === 'D')).toHaveLength(1); // D appears only once
  });

  it('throws on circular dependency', async () => {
    const { resolveDependencies } = await import('../../src/registry/resolver.js');
    const index: RegistryIndex = {
      generated_at: '', version: '1',
      packages: [indexEntry('B', 'tool')],
    };
    // A requires B, B requires A — cycle
    const fetchMeta: (name: string) => Promise<PackageMetadata> = async (name) => {
      if (name === 'B') return meta('B', { tools: { required: ['A'] } });
      return meta(name);
    };
    const pkgMeta = meta('A', { tools: { required: ['B'] } });
    await expect(resolveDependencies('A', pkgMeta, index, EMPTY_LOCKFILE, fetchMeta))
      .rejects.toThrow(/circular/i);
  });

  it('skips packages already in lockfile for required list', async () => {
    const { resolveDependencies } = await import('../../src/registry/resolver.js');
    const index: RegistryIndex = {
      generated_at: '', version: '1',
      packages: [indexEntry('repo-manager', 'tool')],
    };
    const lockfile: Lockfile = {
      installed: { 'repo-manager': { version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256: 'abc' } },
    };
    const pkgMeta = meta('software-full', { tools: { required: ['repo-manager'] } });
    const result = await resolveDependencies('software-full', pkgMeta, index, lockfile, MOCK_FETCH);
    // Already installed — should still appear in required list (caller handles required_by update)
    // But should not be duplicated
    expect(result.required.filter(d => d.name === 'repo-manager')).toHaveLength(1);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd cli && pnpm test -- --reporter=verbose tests/registry/resolver.test.ts
```

Expected: FAIL — `Cannot find module '../../src/registry/resolver.js'`

**Step 3: Create `cli/src/registry/resolver.ts`**

```ts
import type { PackageMetadata, PackageType, RegistryIndex, Lockfile, PackageDependencies } from './types.js';

export interface DependencyNode {
  name: string;
  type: PackageType;
}

export interface ResolvedGraph {
  required: DependencyNode[];
  recommended: DependencyNode[];
}

type MetadataFetcher = (name: string) => Promise<PackageMetadata>;

/**
 * Extract all required+recommended dep names from a PackageDependencies object,
 * paired with their type (looked up from the index).
 */
function flattenDeps(
  deps: PackageDependencies,
  kind: 'required' | 'recommended',
  index: RegistryIndex,
): DependencyNode[] {
  const nodes: DependencyNode[] = [];
  for (const [_category, spec] of Object.entries(deps)) {
    const names: string[] = (spec as Record<string, string[]>)[kind] ?? [];
    for (const name of names) {
      const entry = index.packages.find(p => p.name === name);
      if (entry) {
        nodes.push({ name, type: entry.type as PackageType });
      }
    }
  }
  return nodes;
}

/**
 * Resolve the full dependency graph for a package.
 *
 * - required deps are resolved recursively (DFS)
 * - recommended deps from the root package only (no recursion)
 * - cycle detection throws with a clear message
 * - deduplication: each package appears at most once in required
 *
 * @param fetchMeta - injectable for testing; defaults to RegistryClient.fetchMetadata
 */
export async function resolveDependencies(
  rootPackageName: string,
  meta: PackageMetadata,
  index: RegistryIndex,
  lockfile: Lockfile,
  fetchMeta: MetadataFetcher,
): Promise<ResolvedGraph> {
  const resolved = new Map<string, DependencyNode>(); // name → node (deduplication)
  const visiting = new Set<string>(); // for cycle detection

  async function visit(name: string, pkgMeta: PackageMetadata): Promise<void> {
    if (visiting.has(name)) {
      throw new Error(`Circular dependency detected: ${name} is part of a cycle`);
    }
    if (resolved.has(name)) return; // already processed

    visiting.add(name);

    if (pkgMeta.dependencies) {
      const requiredNodes = flattenDeps(pkgMeta.dependencies, 'required', index);
      for (const node of requiredNodes) {
        if (!resolved.has(node.name)) {
          const subMeta = await fetchMeta(node.name);
          await visit(node.name, subMeta);
          resolved.set(node.name, node);
        }
      }
    }

    visiting.delete(name);
  }

  // Resolve transitive required deps (not the root itself)
  if (meta.dependencies) {
    const firstLevelRequired = flattenDeps(meta.dependencies, 'required', index);
    for (const node of firstLevelRequired) {
      const subMeta = await fetchMeta(node.name);
      await visit(node.name, subMeta);
      if (!resolved.has(node.name)) {
        resolved.set(node.name, node);
      }
    }
  }

  // Recommended at first level only — no recursion
  const recommended: DependencyNode[] = meta.dependencies
    ? flattenDeps(meta.dependencies, 'recommended', index)
    : [];

  return {
    required: Array.from(resolved.values()),
    recommended,
  };
}
```

**Step 4: Run tests to verify they pass**

```bash
cd cli && pnpm test -- --reporter=verbose tests/registry/resolver.test.ts
```

Expected: all 6 tests PASS.

**Step 5: Typecheck**

```bash
cd cli && pnpm typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add cli/src/registry/resolver.ts cli/tests/registry/resolver.test.ts
git commit -m "feat(registry): add dependency resolver with cycle detection and deduplication (STU-202)"
```

---

## Task 4: Update `install.ts` — Integrate Dependency Resolution

**Files:**
- Modify: `cli/src/commands/registry/install.ts`
- Modify: `cli/tests/commands/registry/install.test.ts`

**Step 1: Write the new failing tests**

Add to `cli/tests/commands/registry/install.test.ts` (keep existing tests, append new `describe` blocks):

```ts
// Add these imports at the top of the file
import { writeFile } from 'node:fs/promises';

// --- New describe blocks (append after existing ones) ---

const MOCK_TOOL_META = {
  name: 'repo-manager',
  type: 'tool',
  version: '1.0.0',
  description: 'File manager',
  author: 'studio-core',
  license: 'MIT',
  tags: [],
  studio_version: '>=7.0.0',
};

const MOCK_INDEX_WITH_DEPS = {
  generated_at: '2026-02-28T00:00:00Z',
  version: '1',
  packages: [
    {
      name: 'software-full',
      type: 'template',
      version: '2.0.0',
      description: 'Full software template',
      author: 'studio-core',
      license: 'MIT',
      tags: [],
      studio_version: '>=7.0.0',
      downloads: 0,
    },
    { ...MOCK_TOOL_META, downloads: 0 },
  ],
};

const MOCK_TEMPLATE_META_WITH_DEPS = {
  ...MOCK_INDEX_WITH_DEPS.packages[0],
  dependencies: {
    tools: { required: ['repo-manager'] },
  },
};

describe('installPackage — with required dependencies', () => {
  beforeEach(async () => {
    await mkdir(STUDIO_DIR, { recursive: true });
    // Reset modules so vi.mock picks up fresh state
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('auto-installs required deps without prompting', async () => {
    // Mock cache to return index with both packages
    vi.mock('../../../src/registry/cache.js', () => {
      class RegistryCache {
        read() { return Promise.resolve(MOCK_INDEX_WITH_DEPS); }
        write() { return Promise.resolve(undefined); }
        isFresh() { return Promise.resolve(true); }
      }
      return { RegistryCache };
    });

    vi.stubGlobal('fetch', vi.fn()
      // First call: fetch template metadata (has dependencies)
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_TEMPLATE_META_WITH_DEPS })
      // Second call: download template directory listing (GitHub API)
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      // Third call: fetch repo-manager metadata (dep)
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_TOOL_META })
      // Fourth call: download repo-manager file
      .mockResolvedValueOnce({ ok: true, text: async () => 'name: repo_manager\n' }),
    );

    const { installPackage } = await import('../../../src/commands/registry/install.js');
    await installPackage('software-full', { studioDir: STUDIO_DIR, force: true });

    // Both packages should be in lockfile
    const lf = JSON.parse(await readFile(resolve(STUDIO_DIR, 'registry.lock.json'), 'utf8'));
    expect(lf.installed['software-full']).toBeDefined();
    expect(lf.installed['repo-manager']).toBeDefined();
    // repo-manager should have required_by: ['software-full']
    expect(lf.installed['repo-manager'].required_by).toEqual(['software-full']);
  });

  it('updates required_by if dep already installed', async () => {
    // Pre-install repo-manager
    await mkdir(resolve(STUDIO_DIR, 'tools'), { recursive: true });
    await writeFile(resolve(STUDIO_DIR, 'tools', 'repo-manager.tool.yaml'), 'name: repo_manager\n');
    await writeFile(resolve(STUDIO_DIR, 'registry.lock.json'), JSON.stringify({
      installed: {
        'repo-manager': { version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256: 'abc' },
      },
    }));

    vi.mock('../../../src/registry/cache.js', () => {
      class RegistryCache {
        read() { return Promise.resolve(MOCK_INDEX_WITH_DEPS); }
        write() { return Promise.resolve(undefined); }
        isFresh() { return Promise.resolve(true); }
      }
      return { RegistryCache };
    });

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_TEMPLATE_META_WITH_DEPS })
      .mockResolvedValueOnce({ ok: true, json: async () => [] }) // template dir
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_TOOL_META }), // dep meta
    );

    const { installPackage } = await import('../../../src/commands/registry/install.js');
    await installPackage('software-full', { studioDir: STUDIO_DIR, force: true });

    const lf = JSON.parse(await readFile(resolve(STUDIO_DIR, 'registry.lock.json'), 'utf8'));
    // repo-manager was not reinstalled but required_by updated
    expect(lf.installed['repo-manager'].required_by).toContain('software-full');
  });
});
```

**Step 2: Run new tests to verify they fail**

```bash
cd cli && pnpm test -- --reporter=verbose tests/commands/registry/install.test.ts
```

Expected: new tests FAIL — required dep not installed / `required_by` not present.

**Step 3: Update `install.ts` to integrate dependency resolution**

Replace the current `installPackage` function. The key changes:
1. Import `resolveDependencies` and `RegistryClient.fetchMetadata` as the fetcher
2. After installing root package, resolve and install deps
3. For `required` deps: if already installed → `addRequiredBy`; otherwise → `installPackage` recursively
4. For `recommended`: prompt with `@inquirer/prompts confirm`

```ts
import chalk from 'chalk';
import { resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { RegistryClient } from '../../registry/client.js';
import { RegistryLockfile } from '../../registry/lockfile.js';
import { RegistryCache } from '../../registry/cache.js';
import { syncRegistry } from './sync.js';
import { findStudioDir } from '../../studio-dir.js';
import { resolveDependencies } from '../../registry/resolver.js';
import type { PackageMetadata, PackageType } from '../../registry/types.js';
import { INSTALL_DIRS } from '../../registry/types.js';

const SINGLE_FILE_EXTENSIONS: Partial<Record<PackageType, string>> = {
  tool: '.tool.yaml',
  pipeline: '.pipeline.yaml',
  integration: '.integration.yaml',
  agent: '.agent.yaml',
  skill: '.skill.md',
};

const SHELL_EXEC_PATTERN = /execute:\s*\n\s+type:\s*shell/;

interface InstallOptions {
  studioDir?: string;
  force?: boolean;
  cwd?: string;
  requiredBy?: string;    // ← new: parent package that requires this one
  _depth?: number;        // ← internal: recursion guard (not exposed to CLI)
}

export async function installPackage(nameAtVersion: string, options: InstallOptions = {}): Promise<void> {
  const [name, requestedVersion] = nameAtVersion.split('@');

  const studioDir = options.studioDir ??
    (await findStudioDir(options.cwd ?? process.cwd()) ?? resolve(process.cwd(), '.studio'));
  const lockfile = new RegistryLockfile(studioDir);
  const depth = options._depth ?? 0;
  const indent = '  '.repeat(depth);

  // Check already installed
  const existing = await lockfile.get(name);
  if (existing && !options.force) {
    // If called as a dep, update required_by
    if (options.requiredBy) {
      await lockfile.addRequiredBy(name, options.requiredBy);
    }
    if (depth === 0) {
      console.log(chalk.yellow(`${name} v${existing.version} is already installed. Use --force to reinstall.`));
    }
    return;
  }

  // Sync cache and resolve package type
  await syncRegistry({ force: false, silent: true });
  const cache = new RegistryCache();
  const index = await cache.read();
  const indexEntry = index?.packages.find(p => p.name === name);
  if (!indexEntry) throw new Error(`Package '${name}' not found in registry`);

  const type = indexEntry.type as PackageType;
  const client = new RegistryClient();
  const meta = await client.fetchMetadata(type, name) as PackageMetadata;
  const version = requestedVersion ?? meta.version;

  console.log(`${indent}Installing ${depth > 0 ? 'dependency: ' : ''}${chalk.bold(name)} v${version} [${type}]...`);

  let sha256: string;
  const destBaseDir = resolve(studioDir, INSTALL_DIRS[type]);
  await mkdir(destBaseDir, { recursive: true });

  if (type === 'template' || type === 'plugin') {
    const destDir = resolve(destBaseDir, name);
    await mkdir(destDir, { recursive: true });
    sha256 = await client.downloadDirectory(type, name, 'project', destDir);
  } else {
    const ext = SINGLE_FILE_EXTENSIONS[type] ?? '.yaml';
    const filename = `${name}${ext}`;
    const result = await client.downloadFile(type, name, filename, destBaseDir);
    sha256 = result.sha256;

    // Security check for shell commands
    const content = await readFile(result.destPath, 'utf8');
    if (SHELL_EXEC_PATTERN.test(content)) {
      const { confirm } = await import('@inquirer/prompts');
      const proceed = await confirm({
        message: chalk.yellow(`⚠ This package executes shell commands. Review ${result.destPath} before use. Install anyway?`),
        default: false,
      });
      if (!proceed) {
        const { unlink } = await import('node:fs/promises');
        await unlink(result.destPath);
        console.log('Installation cancelled.');
        return;
      }
    }
  }

  // Check requires_binaries
  if (meta.requires_binaries?.length) {
    const { spawnSync } = await import('node:child_process');
    for (const bin of meta.requires_binaries) {
      const check = spawnSync('which', [bin], { encoding: 'utf8' });
      if (check.status !== 0) {
        console.log(chalk.yellow(`⚠ Warning: required binary '${bin}' not found in PATH`));
      }
    }
  }

  await lockfile.add(name, {
    version,
    type,
    installed_at: new Date().toISOString().split('T')[0],
    sha256,
    required_by: options.requiredBy ? [options.requiredBy] : [],
  });

  console.log(`${indent}${chalk.green(`✓ Installed ${name} v${version}`)}`);

  // Resolve and install dependencies
  if (meta.dependencies && index) {
    const lockfileData = await lockfile.read();
    const graph = await resolveDependencies(
      name,
      meta,
      index,
      lockfileData,
      (depName) => client.fetchMetadata(indexEntry.type as PackageType, depName) as Promise<PackageMetadata>,
    );

    // Install required deps
    for (const dep of graph.required) {
      await installPackage(dep.name, {
        studioDir,
        requiredBy: name,
        _depth: depth + 1,
      });
    }

    // Prompt for recommended (first level only — only when depth === 0)
    if (depth === 0 && graph.recommended.length > 0) {
      const names = graph.recommended.map(d => d.name).join(', ');
      const { confirm } = await import('@inquirer/prompts');
      const install = await confirm({
        message: `Install recommended packages? [${names}]`,
        default: true,
      });
      if (install) {
        for (const dep of graph.recommended) {
          await installPackage(dep.name, { studioDir, _depth: depth + 1 });
        }
      }
    }
  }
}

export async function installCommand(nameAtVersion: string, options: { force?: boolean } = {}): Promise<void> {
  try {
    await installPackage(nameAtVersion, options);
  } catch (err) {
    console.error(chalk.red(`Install failed: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }
}
```

**Step 4: Run all install tests**

```bash
cd cli && pnpm test -- --reporter=verbose tests/commands/registry/install.test.ts
```

Expected: all tests PASS (including the original 2 and the new ones).

**Step 5: Typecheck**

```bash
cd cli && pnpm typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add cli/src/commands/registry/install.ts cli/tests/commands/registry/install.test.ts
git commit -m "feat(registry): integrate dependency resolution in studio registry install (STU-202)"
```

---

## Task 5: Update `remove.ts` — required_by check + orphan cleanup

**Files:**
- Modify: `cli/src/commands/registry/remove.ts`
- Modify: `cli/tests/commands/registry/remove.test.ts`

**Step 1: Write the new failing tests**

Add to `cli/tests/commands/registry/remove.test.ts` (keep existing tests, append):

```ts
import { vi } from 'vitest';  // add vi to existing import

// Append these describe blocks:

describe('removePackage — required_by protection', () => {
  beforeEach(async () => {
    await mkdir(resolve(STUDIO, 'tools'), { recursive: true });
    await writeFile(resolve(STUDIO, 'tools', 'repo-manager.tool.yaml'), 'name: repo_manager\n');
    await writeFile(resolve(STUDIO, 'registry.lock.json'), JSON.stringify({
      installed: {
        'repo-manager': {
          version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256: 'abc',
          required_by: ['software-full'],
        },
      },
    }));
  });
  afterEach(async () => { await rm(TMP, { recursive: true, force: true }); vi.resetModules(); });

  it('throws if package is required by another installed package', async () => {
    const { removePackage } = await import('../../../src/commands/registry/remove.js');
    await expect(removePackage('repo-manager', { studioDir: STUDIO }))
      .rejects.toThrow(/required by.*software-full/i);
  });
});

describe('removePackage — orphan cleanup', () => {
  beforeEach(async () => {
    await mkdir(resolve(STUDIO, 'tools'), { recursive: true });
    // software-full template dir
    await mkdir(resolve(STUDIO, 'projects', 'software-full'), { recursive: true });
    // repo-manager tool is a dep of software-full
    await writeFile(resolve(STUDIO, 'tools', 'repo-manager.tool.yaml'), 'name: repo_manager\n');
    await writeFile(resolve(STUDIO, 'registry.lock.json'), JSON.stringify({
      installed: {
        'software-full': {
          version: '2.0.0', type: 'template', installed_at: '2026-02-28', sha256: 'def',
          required_by: [],
        },
        'repo-manager': {
          version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256: 'abc',
          required_by: ['software-full'],
        },
      },
    }));
  });
  afterEach(async () => { await rm(TMP, { recursive: true, force: true }); vi.resetModules(); });

  it('prompts about orphans and removes them when confirmed', async () => {
    // Mock confirm to return true
    vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn().mockResolvedValue(true) }));
    const { removePackage } = await import('../../../src/commands/registry/remove.js');
    await removePackage('software-full', { studioDir: STUDIO });

    const lf = JSON.parse(await readFile(resolve(STUDIO, 'registry.lock.json'), 'utf8'));
    expect(lf.installed['software-full']).toBeUndefined();
    expect(lf.installed['repo-manager']).toBeUndefined();
  });

  it('leaves orphans installed when user declines', async () => {
    vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn().mockResolvedValue(false) }));
    const { removePackage } = await import('../../../src/commands/registry/remove.js');
    await removePackage('software-full', { studioDir: STUDIO });

    const lf = JSON.parse(await readFile(resolve(STUDIO, 'registry.lock.json'), 'utf8'));
    expect(lf.installed['software-full']).toBeUndefined();
    expect(lf.installed['repo-manager']).toBeDefined(); // left installed
  });
});
```

**Step 2: Run new tests to verify they fail**

```bash
cd cli && pnpm test -- --reporter=verbose tests/commands/registry/remove.test.ts
```

Expected: new tests FAIL — no `required_by` check / no orphan prompt.

**Step 3: Update `remove.ts`**

```ts
import chalk from 'chalk';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { RegistryLockfile } from '../../registry/lockfile.js';
import { findStudioDir } from '../../studio-dir.js';
import { INSTALL_DIRS } from '../../registry/types.js';
import type { PackageType } from '../../registry/types.js';

interface RemoveOptions {
  studioDir?: string;
  cwd?: string;
}

const FILE_EXTENSIONS: Partial<Record<PackageType, string>> = {
  tool: '.tool.yaml',
  pipeline: '.pipeline.yaml',
  integration: '.integration.yaml',
  agent: '.agent.yaml',
  skill: '.skill.md',
};

async function deletePackageFiles(studioDir: string, name: string, type: PackageType): Promise<void> {
  const destDir = resolve(studioDir, INSTALL_DIRS[type]);
  if (type === 'template' || type === 'plugin') {
    const dirPath = resolve(destDir, name);
    if (existsSync(dirPath)) await rm(dirPath, { recursive: true });
  } else {
    const ext = FILE_EXTENSIONS[type] ?? '.yaml';
    const filePath = resolve(destDir, `${name}${ext}`);
    if (existsSync(filePath)) await rm(filePath);
  }
}

export async function removePackage(name: string, options: RemoveOptions = {}): Promise<void> {
  const studioDir = options.studioDir ??
    (await findStudioDir(options.cwd ?? process.cwd()) ?? resolve(process.cwd(), '.studio'));
  const lockfile = new RegistryLockfile(studioDir);
  const entry = await lockfile.get(name);
  if (!entry) throw new Error(`'${name}' is not installed`);

  // Block removal if another package depends on this one
  const dependents = (entry.required_by ?? []).filter(d => d !== '');
  if (dependents.length > 0) {
    throw new Error(`'${name}' is required by: ${dependents.join(', ')}. Remove them first.`);
  }

  const type = entry.type as PackageType;
  await deletePackageFiles(studioDir, name, type);
  await lockfile.remove(name);
  console.log(chalk.green(`✓ Removed ${name}`));

  // Find orphans: packages whose required_by now only contains 'name'
  const data = await lockfile.read();
  const orphans: string[] = [];
  for (const [pkgName, pkgEntry] of Object.entries(data.installed)) {
    const wasRequired = pkgEntry.required_by?.includes(name);
    const otherRequirers = (pkgEntry.required_by ?? []).filter(r => r !== name);
    if (wasRequired && otherRequirers.length === 0) {
      orphans.push(pkgName);
    }
  }

  if (orphans.length > 0) {
    const { confirm } = await import('@inquirer/prompts');
    const cleanup = await confirm({
      message: `These packages are no longer needed: [${orphans.join(', ')}]. Remove them?`,
      default: true,
    });
    if (cleanup) {
      for (const orphan of orphans) {
        await removePackage(orphan, { studioDir });
      }
    } else {
      console.log(chalk.yellow(`Packages left installed: [${orphans.join(', ')}]`));
    }
  }
}

export async function removeCommand(name: string): Promise<void> {
  try {
    await removePackage(name);
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}
```

**Step 4: Run all remove tests**

```bash
cd cli && pnpm test -- --reporter=verbose tests/commands/registry/remove.test.ts
```

Expected: all tests PASS (including the original 2 and the 4 new ones).

**Step 5: Typecheck**

```bash
cd cli && pnpm typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add cli/src/commands/registry/remove.ts cli/tests/commands/registry/remove.test.ts
git commit -m "feat(registry): add required_by protection and orphan cleanup in studio registry remove (STU-202)"
```

---

## Task 6: Full Test Suite + Build Verification

**Step 1: Run full CLI test suite**

```bash
cd cli && pnpm test
```

Expected: all tests PASS. No regressions.

**Step 2: Full monorepo build**

```bash
cd /path/to/Studio && pnpm build
```

Expected: build completes with no errors.

**Step 3: Smoke test (optional — if you have a local .studio/ project)**

```bash
studio registry install <some-package-with-deps>
# Verify required deps auto-installed
# Verify prompt for recommended

studio registry remove <that-package>
# Verify orphan prompt appears
# Verify cascade removal on Y
```

**Step 4: Final commit if any fixes were needed**

```bash
git add -p
git commit -m "fix(registry): address test suite issues after full run (STU-202)"
```

---

## Task 7: Worktree Completion

Use the `superpowers:finishing-a-development-branch` skill to decide how to merge this work.

```bash
# Check branch status
git log --oneline main..HEAD
git status
```

Expected: 6 commits ahead of main, clean working tree.
