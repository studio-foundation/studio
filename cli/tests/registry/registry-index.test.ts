import { describe, it, expect } from 'vitest';
import { candidatesFor, entryFor, parsePackageRef } from '../../src/registry/registry-index.js';
import type { IndexedPackage } from '../../src/registry/registry-index.js';

function pkg(name: string, marketplace: string, version = '1.0.0'): IndexedPackage {
  return {
    name, marketplace, version,
    type: 'plugin', description: '', author: '', license: 'MIT', tags: [],
    studio_version: null, downloads: 0,
    source: { type: 'local', path: `plugins/${name}` },
  };
}

describe('candidatesFor', () => {
  it('returns every version of a name', () => {
    const packages = [pkg('git', 'studio-community', '1.0.0'), pkg('git', 'studio-community', '2.0.0')];
    expect(candidatesFor(packages, 'git').map(p => p.version)).toEqual(['1.0.0', '2.0.0']);
  });

  it('refuses to pick when the same name exists in several marketplaces', () => {
    const packages = [pkg('deploy', 'studio-community'), pkg('deploy', 'acme-corp')];
    expect(() => candidatesFor(packages, 'deploy'))
      .toThrow(/several marketplaces.*studio-community:deploy or acme-corp:deploy/s);
  });

  it('resolves a collision once the name is qualified', () => {
    const packages = [pkg('deploy', 'studio-community'), pkg('deploy', 'acme-corp')];
    expect(candidatesFor(packages, 'deploy', 'acme-corp')).toEqual([packages[1]]);
  });
});

describe('entryFor', () => {
  it('picks the entry of the requested version, which carries its own source', () => {
    const packages = [pkg('git', 'studio-community', '1.0.0'), pkg('git', 'studio-community', '2.0.0')];
    expect(entryFor(packages, 'git', '2.0.0')!.version).toBe('2.0.0');
  });

  it('returns null for an unknown name', () => {
    expect(entryFor([], 'ghost')).toBeNull();
  });
});

describe('parsePackageRef', () => {
  it.each([
    ['git', { marketplace: undefined, name: 'git', version: undefined }],
    ['git@1.2.0', { marketplace: undefined, name: 'git', version: '1.2.0' }],
    ['acme-corp:deploy@2.0.0', { marketplace: 'acme-corp', name: 'deploy', version: '2.0.0' }],
  ])('parses %s', (raw, expected) => {
    expect(parsePackageRef(raw)).toEqual(expected);
  });
});
