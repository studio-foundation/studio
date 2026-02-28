import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const TMP = resolve(import.meta.dirname, '.tmp-sync');
const MOCK_INDEX = { generated_at: '2026-02-28T00:00:00Z', version: '1', packages: [] };

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => MOCK_INDEX }));
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('syncRegistry', () => {
  it('writes index.json to cache dir when forced', async () => {
    const { syncRegistry } = await import('../../../src/commands/registry/sync.js');
    await syncRegistry({ cacheDir: TMP, force: true });
    const raw = await readFile(resolve(TMP, 'index.json'), 'utf8');
    const data = JSON.parse(raw);
    expect(data.version).toBe('1');
  });

  it('skips sync if cache is fresh and force=false', async () => {
    // Write a fresh cache first
    const { RegistryCache } = await import('../../../src/registry/cache.js');
    const cache = new RegistryCache(TMP);
    await cache.write(MOCK_INDEX);
    vi.mocked(fetch).mockClear();

    const { syncRegistry } = await import('../../../src/commands/registry/sync.js');
    await syncRegistry({ cacheDir: TMP, force: false });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
