import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { seedIndex, seedFile, seedFiles } from '../../src/registry/seed.js';

const TMP = resolve('/tmp', '.studio-seed-test');

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** A package the kernel no longer implements — the reason the seed exists. */
const A_MARKETPLACE_TOOL = 'git';

describe('the bundled seed', () => {
  it('carries an index of the official marketplace', () => {
    const index = seedIndex();
    expect(index).not.toBeNull();
    expect(index!.packages.length).toBeGreaterThan(0);
    expect(index!.packages.map((p) => p.name)).toContain(A_MARKETPLACE_TOOL);
  });

  it('addresses files exactly as the registry does', () => {
    const entry = seedIndex()!.packages.find((p) => p.name === A_MARKETPLACE_TOOL)!;
    expect(seedFile(`${entry.source.path}/metadata.json`)).toContain(`"name": "${A_MARKETPLACE_TOOL}"`);
    expect(seedFiles(entry.source.path).map((f) => f.path)).toContain('metadata.json');
  });

  it('has no entry for an unknown path', () => {
    expect(seedFile('plugins/nothing/metadata.json')).toBeNull();
    expect(seedFiles('plugins/nothing')).toEqual([]);
  });
});

describe('RegistryClient falls back to the seed when the network fails', () => {
  it('serves package metadata', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const { RegistryClient } = await import('../../src/registry/client.js');
    const entry = seedIndex()!.packages.find((p) => p.name === A_MARKETPLACE_TOOL)!;

    const meta = await new RegistryClient().fetchMetadata(entry.source, entry.name);
    expect(meta.name).toBe(A_MARKETPLACE_TOOL);
  });

  it('serves a package payload', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const { RegistryClient } = await import('../../src/registry/client.js');
    const entry = seedIndex()!.packages.find((p) => p.name === A_MARKETPLACE_TOOL)!;

    const files = await new RegistryClient().fetchDirectoryFiles(entry.source);
    expect(files.some((f) => f.path.endsWith('.tool.yaml'))).toBe(true);
  });

  it('reports a package that is in neither', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const { RegistryClient } = await import('../../src/registry/client.js');

    await expect(
      new RegistryClient().fetchMetadata({ type: 'local', path: 'plugins/nothing' }, 'nothing'),
    ).rejects.toThrow('getaddrinfo ENOTFOUND');
  });
});

describe('syncRegistry offline', () => {
  it('does not cache the seeded index', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const { syncRegistry } = await import('../../src/commands/registry/sync.js');
    const { RegistryCache } = await import('../../src/registry/cache.js');

    await syncRegistry({ cacheDir: TMP, force: true, silent: true });

    // A cached seed would make the next online run skip its sync for a day.
    expect(await new RegistryCache(TMP).read()).toBeNull();
  });
});
