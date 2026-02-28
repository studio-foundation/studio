import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm, mkdir, readFile, writeFile } from 'node:fs/promises';
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

// --- ADDITIONAL CONSTANTS for dep resolution tests ---

const MOCK_TOOL_META = {
  name: 'repo-manager',
  type: 'tool',
  version: '1.0.0',
  description: 'File manager',
  author: 'studio-core',
  license: 'MIT',
  tags: [] as string[],
  studio_version: '>=7.0.0',
};

const MOCK_INDEX_WITH_DEPS = {
  generated_at: '2026-02-28T00:00:00Z',
  version: '1',
  packages: [
    {
      name: 'software-full',
      type: 'template',
      version: '2.0.0',
      description: 'Full software template',
      author: 'studio-core',
      license: 'MIT',
      tags: [] as string[],
      studio_version: '>=7.0.0',
      downloads: 0,
    },
    { ...MOCK_TOOL_META, downloads: 0 },
  ],
};

const MOCK_TEMPLATE_META_WITH_DEPS = {
  ...MOCK_INDEX_WITH_DEPS.packages[0],
  dependencies: {
    tools: { required: ['repo-manager'] as string[] },
  },
};

describe('installPackage — with required dependencies', () => {
  beforeEach(async () => {
    await mkdir(STUDIO_DIR, { recursive: true });
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('auto-installs required deps without prompting', async () => {
    vi.doMock('../../../src/registry/cache.js', () => {
      class RegistryCache {
        read() { return Promise.resolve(MOCK_INDEX_WITH_DEPS); }
        write() { return Promise.resolve(undefined); }
        isFresh() { return Promise.resolve(true); }
      }
      return { RegistryCache };
    });
    vi.doMock('../../../src/commands/registry/sync.js', () => ({
      syncRegistry: vi.fn().mockResolvedValue(undefined),
    }));

    vi.stubGlobal('fetch', vi.fn()
      // 1. fetch template metadata (has dependencies)
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_TEMPLATE_META_WITH_DEPS })
      // 2. download template dir (GitHub API — empty dir for simplicity)
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      // 3. fetch repo-manager metadata (dep)
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_TOOL_META })
      // 4. download repo-manager file
      .mockResolvedValueOnce({ ok: true, text: async () => 'name: repo_manager\n' }),
    );

    const { installPackage } = await import('../../../src/commands/registry/install.js');
    await installPackage('software-full', { studioDir: STUDIO_DIR, force: true });

    const lf = JSON.parse(await readFile(resolve(STUDIO_DIR, 'registry.lock.json'), 'utf8'));
    expect(lf.installed['software-full']).toBeDefined();
    expect(lf.installed['repo-manager']).toBeDefined();
    expect(lf.installed['repo-manager'].required_by).toEqual(['software-full']);
  });

  it('updates required_by if dep already installed', async () => {
    // Pre-install repo-manager in the lockfile
    await mkdir(resolve(STUDIO_DIR, 'tools'), { recursive: true });
    await writeFile(resolve(STUDIO_DIR, 'tools', 'repo-manager.tool.yaml'), 'name: repo_manager\n');
    await writeFile(resolve(STUDIO_DIR, 'registry.lock.json'), JSON.stringify({
      installed: {
        'repo-manager': { version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256: 'abc' },
      },
    }));

    vi.doMock('../../../src/registry/cache.js', () => {
      class RegistryCache {
        read() { return Promise.resolve(MOCK_INDEX_WITH_DEPS); }
        write() { return Promise.resolve(undefined); }
        isFresh() { return Promise.resolve(true); }
      }
      return { RegistryCache };
    });
    vi.doMock('../../../src/commands/registry/sync.js', () => ({
      syncRegistry: vi.fn().mockResolvedValue(undefined),
    }));

    vi.stubGlobal('fetch', vi.fn()
      // 1. fetch template metadata
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_TEMPLATE_META_WITH_DEPS })
      // 2. download template dir
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      // 3. fetch repo-manager metadata for resolver
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_TOOL_META }),
    );

    const { installPackage } = await import('../../../src/commands/registry/install.js');
    await installPackage('software-full', { studioDir: STUDIO_DIR, force: true });

    const lf = JSON.parse(await readFile(resolve(STUDIO_DIR, 'registry.lock.json'), 'utf8'));
    // repo-manager was not reinstalled but required_by updated
    expect(lf.installed['repo-manager'].required_by).toContain('software-full');
  });
});
