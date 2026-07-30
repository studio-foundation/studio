import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { resolvePackageInfo } from '../../src/commands/registry/info.js';
import { loadMergedIndex, type IndexedPackage } from '../../src/registry/registry-index.js';
import type { LockfileEntry } from '../../src/registry/types.js';

function pkg(overrides: Partial<IndexedPackage> = {}): IndexedPackage {
  return {
    name: 'git',
    type: 'plugin',
    version: '1.4.0',
    description: 'Git operations',
    author: 'studio-core',
    license: 'MIT',
    tags: ['git', 'vcs'],
    studio_version: null,
    downloads: 0,
    marketplace: 'studio-community',
    source: { type: 'local', path: 'plugins/git' },
    ...overrides,
  };
}

function installed(overrides: Partial<LockfileEntry> = {}): LockfileEntry {
  return { version: '1.4.0', type: 'plugin', installed_at: '2026-07-27', sha256: 'abc', ...overrides };
}

describe('resolvePackageInfo', () => {
  it('returns the newest entry and every published version', () => {
    const info = resolvePackageInfo([pkg({ version: '2.0.0' }), pkg({ version: '1.4.0' })], 'git', null);
    expect(info.entry.version).toBe('2.0.0');
    expect(info.versions).toEqual(['2.0.0', '1.4.0']);
    expect(info.installed).toBeNull();
  });

  it('flattens dependencies across categories, keeping the entry as published', () => {
    const info = resolvePackageInfo([pkg({
      dependencies: {
        plugins: { required: ['search@>=1.2.0'], recommended: ['code-conventions'] },
        tools: { required: ['acme-corp:deploy'] },
      },
    })], 'git', null);
    expect(info.dependencies.required).toEqual(['search@>=1.2.0', 'acme-corp:deploy']);
    expect(info.dependencies.recommended).toEqual(['code-conventions']);
  });

  it('reports no dependencies when the entry declares none', () => {
    const info = resolvePackageInfo([pkg()], 'git', null);
    expect(info.dependencies).toEqual({ required: [], recommended: [] });
  });

  it('resolves a marketplace-qualified name', () => {
    const packages = [pkg({ marketplace: 'acme-corp', version: '9.0.0' }), pkg()];
    const info = resolvePackageInfo(packages, 'acme-corp:git', null);
    expect(info.entry.marketplace).toBe('acme-corp');
    expect(info.entry.version).toBe('9.0.0');
  });

  it('refuses an ambiguous unqualified name with the qualified forms', () => {
    const packages = [pkg({ marketplace: 'acme-corp' }), pkg()];
    expect(() => resolvePackageInfo(packages, 'git', null))
      .toThrow(/acme-corp:git or studio-community:git/);
  });

  it('resolves an explicit version', () => {
    const info = resolvePackageInfo([pkg({ version: '2.0.0' }), pkg({ version: '1.4.0' })], 'git@1.4.0', null);
    expect(info.entry.version).toBe('1.4.0');
  });

  it('refuses a version that was never published instead of falling back to the newest', () => {
    expect(() => resolvePackageInfo([pkg({ version: '2.0.0' })], 'git@1.4.0', null))
      .toThrow(/no version 1.4.0 in the registry \(published: 2.0.0\)/);
  });

  it('reports a name absent from the registry', () => {
    expect(() => resolvePackageInfo([pkg()], 'nope', null)).toThrow(/'nope' not found in registry/);
    expect(() => resolvePackageInfo([pkg()], 'acme-corp:git', null))
      .toThrow(/not found in registry in marketplace 'acme-corp'/);
  });

  it('reports the installed version from the lockfile', () => {
    const info = resolvePackageInfo([pkg({ version: '2.0.0' })], 'git', installed({ version: '1.4.0' }));
    expect(info.installed).toMatchObject({ name: 'git', version: '1.4.0' });
  });

  it('flags a package the running CLI is too old for', () => {
    const info = resolvePackageInfo([pkg({ studio_version: '>=999.0.0' })], 'git', null);
    expect(info.incompatible).toMatch(/requires Studio >=999.0.0/);
  });

  it('does not flag a package with no declared range', () => {
    expect(resolvePackageInfo([pkg()], 'git', null).incompatible).toBeNull();
  });
});

const TMP = resolve('/tmp', '.studio-info-test');

describe('info offline', () => {
  beforeEach(async () => { await mkdir(TMP, { recursive: true }); });
  afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

  /** A package the kernel no longer implements — the reason the seed exists. */
  const A_MARKETPLACE_TOOL = 'git';

  it('describes a default-marketplace package from the bundled seed with nothing cached', async () => {
    // Empty cache dir, no marketplaces file: exactly a fresh install with no network.
    const { packages } = await loadMergedIndex({
      cacheDir: TMP,
      marketplacesFile: join(TMP, 'marketplaces.json'),
      seed: true,
    });

    const info = resolvePackageInfo(packages, A_MARKETPLACE_TOOL, null);
    expect(info.entry.marketplace).toBe('studio-community');
    expect(info.entry.license).toBeTruthy();
    expect(info.versions.length).toBeGreaterThan(0);
  });

  it('finds nothing without the seed, which is what makes the fallback load-bearing', async () => {
    const { packages } = await loadMergedIndex({
      cacheDir: TMP,
      marketplacesFile: join(TMP, 'marketplaces.json'),
    });
    expect(() => resolvePackageInfo(packages, A_MARKETPLACE_TOOL, null)).toThrow(/not found in registry/);
  });
});
