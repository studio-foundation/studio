import { describe, it, expect } from 'vitest';
import { outdatedEntry } from '../../src/commands/registry/update.js';
import type { LockfileEntry, PackageEntry } from '../../src/registry/types.js';

function candidate(version: string): PackageEntry {
  return {
    name: 'git', type: 'plugin', version, description: '', author: '', license: 'MIT',
    tags: [], studio_version: null, downloads: 0, source: { type: 'local', path: 'packages/git' },
  };
}

function installed(version: string, constraints?: Record<string, string>): { name: string } & LockfileEntry {
  return { name: 'git', version, type: 'plugin', installed_at: '2026-07-27', sha256: 'abc', constraints };
}

describe('outdatedEntry', () => {
  it('reports latest as wanted when nothing constrains the package', () => {
    const row = outdatedEntry(installed('1.0.0'), [candidate('2.0.0'), candidate('1.0.0')]);
    expect(row).toMatchObject({ installed: '1.0.0', wanted: '2.0.0', latest: '2.0.0' });
    expect(row!.heldBy).toBeUndefined();
  });

  it('separates the version a dependent accepts from the newest published', () => {
    const row = outdatedEntry(
      installed('1.0.0', { software: '<2.0.0' }),
      [candidate('2.0.0'), candidate('1.4.0'), candidate('1.0.0')],
    );
    expect(row).toMatchObject({ installed: '1.0.0', wanted: '1.4.0', latest: '2.0.0' });
    expect(row!.heldBy).toBe("'<2.0.0' (required by software)");
  });

  it('reports a zero-move row when no published version satisfies the constraints', () => {
    const row = outdatedEntry(installed('1.0.0', { software: '>=3.0.0' }), [candidate('2.0.0'), candidate('1.0.0')]);
    expect(row).toMatchObject({ installed: '1.0.0', wanted: '1.0.0', latest: '2.0.0' });
    expect(row!.heldBy).toBe("'>=3.0.0' (required by software)");
  });

  it('skips a package already at the highest version its constraints allow', () => {
    expect(outdatedEntry(installed('1.4.0', { software: '<2.0.0' }), [candidate('1.4.0')])).toBeNull();
  });

  it('skips a package absent from the index', () => {
    expect(outdatedEntry(installed('1.0.0'), [])).toBeNull();
  });
});
