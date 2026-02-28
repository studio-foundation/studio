import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RegistryCache } from '../../src/registry/cache.js';
import type { RegistryIndex } from '../../src/registry/types.js';

const TMP = resolve(import.meta.dirname, '.tmp-registry-cache');

const MOCK_INDEX: RegistryIndex = {
  generated_at: '2026-02-28T00:00:00Z',
  version: '1',
  packages: [
    {
      name: 'software',
      type: 'template',
      version: '1.0.0',
      description: 'Test template',
      author: 'studio-core',
      license: 'MIT',
      tags: ['software'],
      studio_version: '>=7.0.0',
      downloads: 0,
    },
  ],
};

beforeEach(async () => { await mkdir(TMP, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

describe('RegistryCache', () => {
  it('returns null when cache does not exist', async () => {
    const cache = new RegistryCache(TMP);
    expect(await cache.read()).toBeNull();
  });

  it('writes and reads back correctly', async () => {
    const cache = new RegistryCache(TMP);
    await cache.write(MOCK_INDEX);
    const result = await cache.read();
    expect(result).not.toBeNull();
    expect(result!.packages).toHaveLength(1);
    expect(result!.packages[0].name).toBe('software');
  });

  it('returns null when cache is expired', async () => {
    const cache = new RegistryCache(TMP);
    await cache.write(MOCK_INDEX);
    // Force expire by overwriting with old _cached_at
    const cachePath = resolve(TMP, 'index.json');
    const data = JSON.parse(await readFile(cachePath, 'utf8'));
    data._cached_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await writeFile(cachePath, JSON.stringify(data));
    expect(await cache.read()).toBeNull();
  });

  it('isFresh returns false when no cache', async () => {
    const cache = new RegistryCache(TMP);
    expect(await cache.isFresh()).toBe(false);
  });

  it('isFresh returns true right after write', async () => {
    const cache = new RegistryCache(TMP);
    await cache.write(MOCK_INDEX);
    expect(await cache.isFresh()).toBe(true);
  });
});
