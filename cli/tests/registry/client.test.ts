import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const TMP = resolve(import.meta.dirname, '.tmp-client');

const MOCK_INDEX = {
  generated_at: '2026-02-28T00:00:00Z',
  version: '1',
  packages: [
    { name: 'software', type: 'template', version: '1.0.0', description: 'Test', author: 'studio-core', license: 'MIT', tags: [], studio_version: null, downloads: 0 },
  ],
};

const MOCK_METADATA = {
  name: 'software',
  version: '1.0.0',
  description: 'Code generation',
  author: 'studio-core',
  license: 'MIT',
  tags: ['software'],
  type: 'template',
  studio_version: '>=7.0.0',
};

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('RegistryClient.fetchIndex', () => {
  it('fetches and returns the registry index', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => MOCK_INDEX,
    } as Response);

    const { RegistryClient } = await import('../../src/registry/client.js');
    const client = new RegistryClient();
    const index = await client.fetchIndex();
    expect(index.packages).toHaveLength(1);
    expect(index.packages[0].name).toBe('software');
  });

  it('throws on non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    const { RegistryClient } = await import('../../src/registry/client.js');
    const client = new RegistryClient();
    await expect(client.fetchIndex()).rejects.toThrow('Failed to fetch registry index');
  });
});

describe('RegistryClient.fetchMetadata', () => {
  it('fetches package metadata', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => MOCK_METADATA,
    } as Response);
    const { RegistryClient } = await import('../../src/registry/client.js');
    const client = new RegistryClient();
    const meta = await client.fetchMetadata('template', 'software');
    expect(meta.name).toBe('software');
    expect(meta.type).toBe('template');
  });
});
