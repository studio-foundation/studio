import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm, mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const TMP = resolve(import.meta.dirname, '.tmp-install');
const STUDIO_DIR = join(TMP, '.studio');

const MOCK_METADATA = {
  name: 'linear',
  type: 'integration',
  version: '1.0.0',
  description: 'Linear integration',
  author: 'studio-core',
  license: 'MIT',
  tags: ['linear'],
  studio_version: '>=7.0.0',
};

const MOCK_INDEX = {
  generated_at: '2026-02-28T00:00:00Z',
  version: '1',
  packages: [{ ...MOCK_METADATA, downloads: 0 }],
};

const FAKE_INTEGRATION_CONTENT = 'name: linear\ntype: integration\n';

// Mock syncRegistry to be a no-op (sync already handled), and RegistryCache.read to return mock index
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
  await mkdir(STUDIO_DIR, { recursive: true });
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => MOCK_METADATA })
    .mockResolvedValueOnce({ ok: true, text: async () => FAKE_INTEGRATION_CONTENT }),
  );
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('installPackage', () => {
  it('installs an integration to .studio/integrations/', async () => {
    const { installPackage } = await import('../../../src/commands/registry/install.js');
    await installPackage('linear', { studioDir: STUDIO_DIR, force: true });

    const dest = resolve(STUDIO_DIR, 'integrations', 'linear.integration.yaml');
    const content = await readFile(dest, 'utf8');
    expect(content).toBe(FAKE_INTEGRATION_CONTENT);
  });

  it('writes lockfile entry after install', async () => {
    const { installPackage } = await import('../../../src/commands/registry/install.js');
    await installPackage('linear', { studioDir: STUDIO_DIR, force: true });

    const lf = JSON.parse(await readFile(resolve(STUDIO_DIR, 'registry.lock.json'), 'utf8'));
    expect(lf.installed['linear']).toMatchObject({
      version: '1.0.0',
      type: 'integration',
    });
    expect(lf.installed['linear'].sha256).toBeTruthy();
  });
});
