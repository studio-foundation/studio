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

const MOCK_FETCH = async (name: string): Promise<PackageMetadata> => meta(name);

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

  it('throws a hard error when a required dependency is missing from the index (STU-409)', async () => {
    const { resolveDependencies } = await import('../../src/registry/resolver.js');
    const index: RegistryIndex = { generated_at: '', version: '1', packages: [] };
    const pkgMeta = meta('software-full', {
      tools: { required: ['ghost-tool'] },
    });
    await expect(
      resolveDependencies('software-full', pkgMeta, index, EMPTY_LOCKFILE, MOCK_FETCH)
    ).rejects.toThrow(/required dependency 'ghost-tool'.*software-full/s);
  });

  it('throws when a transitive required dependency is missing', async () => {
    const { resolveDependencies } = await import('../../src/registry/resolver.js');
    const index: RegistryIndex = {
      generated_at: '', version: '1',
      packages: [indexEntry('B', 'tool')],
    };
    const fetchMeta = async (name: string): Promise<PackageMetadata> => {
      if (name === 'B') return meta('B', { tools: { required: ['ghost'] } });
      return meta(name);
    };
    const pkgMeta = meta('A', { tools: { required: ['B'] } });
    await expect(
      resolveDependencies('A', pkgMeta, index, EMPTY_LOCKFILE, fetchMeta)
    ).rejects.toThrow(/required dependency 'ghost'.*'B'/s);
  });

  it('does not throw for a missing recommended dependency (optional)', async () => {
    const { resolveDependencies } = await import('../../src/registry/resolver.js');
    const index: RegistryIndex = { generated_at: '', version: '1', packages: [] };
    const pkgMeta = meta('software-full', {
      skills: { recommended: ['nice-to-have'] },
    });
    const result = await resolveDependencies('software-full', pkgMeta, index, EMPTY_LOCKFILE, MOCK_FETCH);
    expect(result.recommended).toEqual([]);
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
    const fetchMeta = async (name: string): Promise<PackageMetadata> => {
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
    const fetchMeta = async (name: string): Promise<PackageMetadata> => {
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
    const fetchMeta = async (name: string): Promise<PackageMetadata> => {
      if (name === 'B') return meta('B', { tools: { required: ['A'] } });
      return meta(name);
    };
    const pkgMeta = meta('A', { tools: { required: ['B'] } });
    await expect(resolveDependencies('A', pkgMeta, index, EMPTY_LOCKFILE, fetchMeta))
      .rejects.toThrow(/circular/i);
  });

  it('includes already-installed packages in required list (caller handles required_by update)', async () => {
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
    expect(result.required.filter(d => d.name === 'repo-manager')).toHaveLength(1);
  });
});
