import { describe, it, expect } from 'vitest';
import type { PackageMetadata, Lockfile } from '../../src/registry/types.js';
import type { IndexedPackage } from '../../src/registry/registry-index.js';
import { DEFAULT_MARKETPLACE } from '../../src/registry/dependency-spec.js';

// Build a minimal index entry
function indexEntry(name: string, type: string, version = '1.0.0', marketplace = DEFAULT_MARKETPLACE) {
  return {
    name, type, version, marketplace,
    description: '', author: '', license: 'MIT', tags: [], studio_version: null, downloads: 0,
    source: { type: 'local' as const, path: `${type}s/${name}` },
  } as IndexedPackage;
}

function meta(name: string, deps?: PackageMetadata['dependencies']): PackageMetadata {
  return { ...indexEntry(name, 'tool'), dependencies: deps };
}

const EMPTY_LOCKFILE: Lockfile = { installed: {} };

const MOCK_FETCH = async (name: string): Promise<PackageMetadata> => meta(name);

interface GraphOptions {
  lockfile?: Lockfile;
  fetchMeta?: (name: string, marketplace: string) => Promise<PackageMetadata>;
  marketplace?: string;
  registered?: string[];
}

async function resolveGraph(
  root: string,
  pkgMeta: PackageMetadata,
  packages: IndexedPackage[],
  options: GraphOptions = {},
) {
  const { resolveDependencies } = await import('../../src/registry/resolver.js');
  return resolveDependencies(
    root,
    pkgMeta,
    packages,
    options.lockfile ?? EMPTY_LOCKFILE,
    options.fetchMeta ?? MOCK_FETCH,
    {
      marketplace: options.marketplace ?? DEFAULT_MARKETPLACE,
      registered: options.registered ?? [DEFAULT_MARKETPLACE],
    },
  );
}

describe('resolveDependencies', () => {
  it('returns empty graph when package has no dependencies', async () => {
    const result = await resolveGraph('my-pkg', meta('my-pkg'), []);
    expect(result.required).toEqual([]);
    expect(result.recommended).toEqual([]);
  });

  it('resolves required tools from first-level deps', async () => {
    const packages = [indexEntry('repo-manager', 'tool'), indexEntry('shell', 'tool')];
    const pkgMeta = meta('software-full', { tools: { required: ['repo-manager', 'shell'] } });
    const result = await resolveGraph('software-full', pkgMeta, packages);
    expect(result.required.map(d => d.name)).toEqual(expect.arrayContaining(['repo-manager', 'shell']));
    expect(result.required).toHaveLength(2);
    expect(result.recommended).toEqual([]);
  });

  it('returns recommended at first level without recursion', async () => {
    const packages = [indexEntry('code-conventions', 'skill')];
    const pkgMeta = meta('software-full', { skills: { recommended: ['code-conventions'] } });
    const result = await resolveGraph('software-full', pkgMeta, packages);
    expect(result.recommended.map(d => d.name)).toEqual(['code-conventions']);
    expect(result.required).toEqual([]);
  });

  it('throws a hard error when a required dependency is missing from the index (STU-409)', async () => {
    const pkgMeta = meta('software-full', { tools: { required: ['ghost-tool'] } });
    await expect(resolveGraph('software-full', pkgMeta, []))
      .rejects.toThrow(/required dependency 'ghost-tool'.*software-full/s);
  });

  it('throws when a transitive required dependency is missing', async () => {
    const fetchMeta = async (name: string): Promise<PackageMetadata> =>
      name === 'B' ? meta('B', { tools: { required: ['ghost'] } }) : meta(name);
    const pkgMeta = meta('A', { tools: { required: ['B'] } });
    await expect(resolveGraph('A', pkgMeta, [indexEntry('B', 'tool')], { fetchMeta }))
      .rejects.toThrow(/required dependency 'ghost'.*'B'/s);
  });

  it('does not throw for a missing recommended dependency (optional)', async () => {
    const pkgMeta = meta('software-full', { skills: { recommended: ['nice-to-have'] } });
    const result = await resolveGraph('software-full', pkgMeta, []);
    expect(result.recommended).toEqual([]);
    expect(result.required).toEqual([]);
  });

  it('resolves required deps recursively (A requires B which requires C)', async () => {
    const packages = [indexEntry('B', 'tool'), indexEntry('C', 'tool')];
    const fetchMeta = async (name: string): Promise<PackageMetadata> =>
      name === 'B' ? meta('B', { tools: { required: ['C'] } }) : meta(name);
    const pkgMeta = meta('A', { tools: { required: ['B'] } });
    const result = await resolveGraph('A', pkgMeta, packages, { fetchMeta });
    expect(result.required.map(d => d.name)).toEqual(expect.arrayContaining(['B', 'C']));
    expect(result.required).toHaveLength(2);
  });

  it('deduplicates when two paths lead to the same dep', async () => {
    const packages = [indexEntry('B', 'tool'), indexEntry('C', 'tool'), indexEntry('D', 'tool')];
    // A requires B and C, both require D
    const fetchMeta = async (name: string): Promise<PackageMetadata> => {
      if (name === 'B') return meta('B', { tools: { required: ['D'] } });
      if (name === 'C') return meta('C', { tools: { required: ['D'] } });
      return meta(name);
    };
    const pkgMeta = meta('A', { tools: { required: ['B', 'C'] } });
    const result = await resolveGraph('A', pkgMeta, packages, { fetchMeta });
    expect(result.required.map(d => d.name).filter(n => n === 'D')).toHaveLength(1);
  });

  it('throws on circular dependency', async () => {
    // A requires B, B requires A — cycle
    const fetchMeta = async (name: string): Promise<PackageMetadata> =>
      name === 'B' ? meta('B', { tools: { required: ['A'] } }) : meta(name);
    const pkgMeta = meta('A', { tools: { required: ['B'] } });
    await expect(resolveGraph('A', pkgMeta, [indexEntry('B', 'tool')], { fetchMeta }))
      .rejects.toThrow(/circular/i);
  });

  it('resolves the plugins category like any other (STU-693)', async () => {
    const packages = [indexEntry('git', 'plugin'), indexEntry('github', 'plugin')];
    const pkgMeta = meta('software', { plugins: { required: ['git'], recommended: ['github'] } });
    const result = await resolveGraph('software', pkgMeta, packages);
    expect(result.required.map(d => d.name)).toEqual(['git']);
    expect(result.recommended.map(d => d.name)).toEqual(['github']);
  });

  it('picks the highest version satisfying every constraint', async () => {
    const packages = [
      indexEntry('git', 'plugin', '1.0.0'),
      indexEntry('git', 'plugin', '1.4.0'),
      indexEntry('git', 'plugin', '2.0.0'),
    ];
    const pkgMeta = meta('software', { plugins: { required: ['git@>=1.2.0 <2.0.0'] } });
    const result = await resolveGraph('software', pkgMeta, packages);
    expect(result.required[0].version).toBe('1.4.0');
  });

  it('carries every declared range on the node so the caller can record it (STU-203)', async () => {
    const packages = [indexEntry('B', 'plugin'), indexEntry('git', 'plugin', '1.0.0')];
    const fetchMeta = async (name: string): Promise<PackageMetadata> =>
      name === 'B' ? meta('B', { plugins: { required: ['git@>=1.0.0'] } }) : meta(name);
    const pkgMeta = meta('A', { plugins: { required: ['git@<2.0.0', 'B'] } });
    const result = await resolveGraph('A', pkgMeta, packages, { fetchMeta });
    expect(result.required.find(d => d.name === 'git')!.constraints).toEqual([
      { range: '<2.0.0', requiredBy: 'A' },
      { range: '>=1.0.0', requiredBy: 'B' },
    ]);
  });

  it('reports both constraints when ranges conflict', async () => {
    const packages = [indexEntry('B', 'plugin'), indexEntry('git', 'plugin', '1.0.0')];
    // Root wants git >=2.0.0; B wants git <1.5.0 — nothing satisfies both.
    const fetchMeta = async (name: string): Promise<PackageMetadata> =>
      name === 'B' ? meta('B', { plugins: { required: ['git@<1.5.0'] } }) : meta(name);
    const pkgMeta = meta('A', { plugins: { required: ['git@>=2.0.0', 'B'] } });
    await expect(resolveGraph('A', pkgMeta, packages, { fetchMeta }))
      .rejects.toThrow(/'>=2\.0\.0' \(required by A\).*'<1\.5\.0' \(required by B\)/s);
  });

  it('resolves a name qualified with the default marketplace', async () => {
    const pkgMeta = meta('software', { plugins: { required: ['studio-community:git'] } });
    const result = await resolveGraph('software', pkgMeta, [indexEntry('git', 'plugin')]);
    expect(result.required.map(d => d.name)).toEqual(['git']);
  });

  it('refuses a dependency from an unregistered marketplace instead of adding it', async () => {
    const packages = [indexEntry('internal-deploy', 'plugin', '1.0.0', 'acme-corp')];
    const pkgMeta = meta('software', { plugins: { required: ['acme-corp:internal-deploy'] } });
    await expect(resolveGraph('software', pkgMeta, packages))
      .rejects.toThrow(/'acme-corp', which is not registered/);
  });

  it('resolves a dependency from a registered marketplace (STU-694)', async () => {
    const packages = [indexEntry('internal-deploy', 'plugin', '1.0.0', 'acme-corp')];
    const pkgMeta = meta('software', { plugins: { required: ['acme-corp:internal-deploy'] } });
    const result = await resolveGraph('software', pkgMeta, packages, {
      registered: [DEFAULT_MARKETPLACE, 'acme-corp'],
    });
    expect(result.required.map(d => `${d.marketplace}:${d.name}`)).toEqual(['acme-corp:internal-deploy']);
  });

  it('resolves an unqualified dependency in the dependent own marketplace (STU-694)', async () => {
    // Same name in both marketplaces: the one the dependent came from wins, and
    // nothing about registration order can change that.
    const packages = [
      indexEntry('deploy', 'plugin', '1.0.0', DEFAULT_MARKETPLACE),
      indexEntry('deploy', 'plugin', '9.9.9', 'acme-corp'),
    ];
    const pkgMeta = meta('internal-app', { plugins: { required: ['deploy'] } });
    const result = await resolveGraph('internal-app', pkgMeta, packages, {
      marketplace: 'acme-corp',
      registered: [DEFAULT_MARKETPLACE, 'acme-corp'],
    });
    expect(result.required).toEqual([expect.objectContaining({
      name: 'deploy',
      marketplace: 'acme-corp',
      version: '9.9.9',
    })]);
  });

  it('includes already-installed packages in required list (caller handles required_by update)', async () => {
    const lockfile: Lockfile = {
      installed: { 'repo-manager': { version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256: 'abc' } },
    };
    const pkgMeta = meta('software-full', { tools: { required: ['repo-manager'] } });
    const result = await resolveGraph('software-full', pkgMeta, [indexEntry('repo-manager', 'tool')], { lockfile });
    // Already installed — should still appear in required list (caller handles required_by update)
    expect(result.required.filter(d => d.name === 'repo-manager')).toHaveLength(1);
  });
});
