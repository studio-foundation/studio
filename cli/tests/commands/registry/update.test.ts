import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { RegistryIndex } from '../../../src/registry/types.js';

const TMP = resolve(import.meta.dirname, '.tmp-update');
const STUDIO = join(TMP, '.studio');

const MOCK_INDEX: RegistryIndex = {
  generated_at: '2026-02-28T00:00:00Z',
  version: '1',
  packages: [
    { name: 'linear', type: 'integration', version: '2.0.0', description: 'Linear', author: 'studio-core', license: 'MIT', tags: [], studio_version: null, downloads: 0 },
  ],
};

vi.mock('../../../src/commands/registry/sync.js', () => ({
  syncRegistry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/registry/cache.js', () => {
  class RegistryCache {
    read() { return Promise.resolve(MOCK_INDEX); }
    write() { return Promise.resolve(undefined); }
    isFresh() { return Promise.resolve(true); }
  }
  return { RegistryCache };
});

beforeEach(async () => {
  await mkdir(STUDIO, { recursive: true });
  await writeFile(resolve(STUDIO, 'registry.lock.json'), JSON.stringify({
    installed: {
      'linear': { version: '1.0.0', type: 'integration', installed_at: '2026-02-28', sha256: 'old' },
    },
  }));
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('outdatedPackages', () => {
  it('returns packages with newer versions in registry', async () => {
    const { outdatedPackages } = await import('../../../src/commands/registry/update.js');
    const result = await outdatedPackages({ studioDir: STUDIO });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'linear', installed: '1.0.0', latest: '2.0.0' });
  });

  it('returns empty when all packages up to date', async () => {
    // Update lockfile to match registry version
    await writeFile(resolve(STUDIO, 'registry.lock.json'), JSON.stringify({
      installed: {
        'linear': { version: '2.0.0', type: 'integration', installed_at: '2026-02-28', sha256: 'new' },
      },
    }));
    const { outdatedPackages } = await import('../../../src/commands/registry/update.js');
    const result = await outdatedPackages({ studioDir: STUDIO });
    expect(result).toHaveLength(0);
  });
});
