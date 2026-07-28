import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const TMP = resolve(import.meta.dirname, '.tmp-install');
const STUDIO_DIR = join(TMP, '.studio');

/** A GitHub contents listing for a package directory holding a single payload file. */
function dirListing(dir: string, filename: string) {
  return [
    { name: filename, path: `${dir}/${filename}`, type: 'file', download_url: `https://x/${filename}` },
    { name: 'metadata.json', path: `${dir}/metadata.json`, type: 'file', download_url: 'https://x/metadata.json' },
  ];
}

/**
 * A fetch routed by URL rather than by call order — a plugin's files are fetched
 * in the order GitHub lists them, which is not the order a test declares them.
 */
function routedFetch(routes: Array<[RegExp, unknown]>) {
  return vi.fn(async (url: string) => {
    for (const [pattern, body] of routes) {
      if (pattern.test(String(url))) {
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return { ok: true, text: async () => text, json: async () => JSON.parse(text) };
      }
    }
    return { ok: false, status: 404 };
  });
}

const MOCK_METADATA = {
  name: 'linear',
  type: 'plugin',
  version: '1.0.0',
  description: 'Linear trigger',
  author: 'studio-core',
  license: 'MIT',
  tags: ['linear'],
  studio_version: '>=0.1.0',
  provides: { triggers: ['linear'] },
};

const MOCK_INDEX = {
  generated_at: '2026-02-28T00:00:00Z',
  version: '1',
  packages: [{
    ...MOCK_METADATA,
    downloads: 0,
    source: { type: 'local', path: 'plugins/linear' },
  }],
};

const FAKE_TRIGGER_CONTENT = 'name: linear\npipeline: feature-builder\n';

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
  vi.stubGlobal('fetch', routedFetch([
    [/\/plugins\/linear\/metadata\.json$/, MOCK_METADATA],
    [/\/contents\/plugins\/linear$/, dirListing('plugins/linear', 'linear.trigger.yaml')],
    [/x\/linear\.trigger\.yaml$/, FAKE_TRIGGER_CONTENT],
    [/x\/metadata\.json$/, JSON.stringify(MOCK_METADATA)],
  ]));
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('installPackage', () => {
  it('dispatches a plugin payload to the .studio/ dir of its content kind', async () => {
    const { installPackage } = await import('../../../src/commands/registry/install.js');
    await installPackage('linear', { studioDir: STUDIO_DIR, force: true });

    const dest = resolve(STUDIO_DIR, 'triggers', 'linear.trigger.yaml');
    const content = await readFile(dest, 'utf8');
    expect(content).toBe(FAKE_TRIGGER_CONTENT);
  });

  it('records the written files in the lockfile', async () => {
    const { installPackage } = await import('../../../src/commands/registry/install.js');
    await installPackage('linear', { studioDir: STUDIO_DIR, force: true });

    const lf = JSON.parse(await readFile(resolve(STUDIO_DIR, 'registry.lock.json'), 'utf8'));
    expect(lf.installed['linear']).toMatchObject({
      version: '1.0.0',
      type: 'plugin',
      files: ['triggers/linear.trigger.yaml'],
    });
    expect(lf.installed['linear'].sha256).toBeTruthy();
  });

  it('refuses a package that requires a newer Studio', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ ...MOCK_METADATA, studio_version: '>=99.0.0' }),
    }));
    const { installPackage } = await import('../../../src/commands/registry/install.js');

    await expect(installPackage('linear', { studioDir: STUDIO_DIR, force: true })).rejects.toThrow(
      /Package 'linear' requires Studio >=99\.0\.0/
    );
    await expect(
      readFile(resolve(STUDIO_DIR, 'triggers', 'linear.trigger.yaml'), 'utf8')
    ).rejects.toThrow();
  });
});

// --- Package whose directory and payload filename both diverge from its name ---

const MOCK_DIVERGENT_META = {
  name: 'studio-run',
  type: 'plugin',
  version: '1.0.0',
  description: 'Launch a Studio pipeline run',
  author: 'studio-core',
  license: 'MIT',
  tags: [] as string[],
  studio_version: '>=0.1.0',
  provides: { tools: ['studio-run'] },
};

const MOCK_DIVERGENT_INDEX = {
  generated_at: '2026-02-28T00:00:00Z',
  version: '1',
  packages: [{
    ...MOCK_DIVERGENT_META,
    downloads: 0,
    source: { type: 'local', path: 'plugins/studio' },
  }],
};

describe('installPackage — directory name diverges from package name', () => {
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

  it('lists source.path and keeps the published filename', async () => {
    vi.doMock('../../../src/registry/cache.js', () => {
      class RegistryCache {
        read() { return Promise.resolve(MOCK_DIVERGENT_INDEX); }
        write() { return Promise.resolve(undefined); }
        isFresh() { return Promise.resolve(true); }
      }
      return { RegistryCache };
    });
    vi.doMock('../../../src/commands/registry/sync.js', () => ({
      syncRegistry: vi.fn().mockResolvedValue(undefined),
    }));

    const mockFetch = routedFetch([
      [/\/plugins\/studio\/metadata\.json$/, MOCK_DIVERGENT_META],
      [/\/contents\/plugins\/studio$/, dirListing('plugins/studio', 'run-pipeline.tool.yaml')],
      [/x\/run-pipeline\.tool\.yaml$/, 'name: studio_run\n'],
      [/x\/metadata\.json$/, JSON.stringify(MOCK_DIVERGENT_META)],
    ]);
    vi.stubGlobal('fetch', mockFetch);

    const { installPackage } = await import('../../../src/commands/registry/install.js');
    await installPackage('studio-run', { studioDir: STUDIO_DIR, force: true });

    expect(mockFetch.mock.calls[0][0]).toMatch(/\/plugins\/studio\/metadata\.json$/);
    expect(mockFetch.mock.calls[1][0]).toMatch(/\/contents\/plugins\/studio$/);

    // The agent and skill loaders resolve by filename, so payload names are kept as published.
    const dest = resolve(STUDIO_DIR, 'tools', 'run-pipeline.tool.yaml');
    expect(await readFile(dest, 'utf8')).toBe('name: studio_run\n');
  });
});

// --- ADDITIONAL CONSTANTS for dep resolution tests ---

const MOCK_TOOL_META = {
  name: 'repo-manager',
  type: 'plugin',
  version: '1.0.0',
  description: 'File manager',
  author: 'studio-core',
  license: 'MIT',
  tags: [] as string[],
  studio_version: '>=0.1.0',
  provides: { tools: ['repo_manager'] },
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
      studio_version: '>=0.1.0',
      downloads: 0,
      source: { type: 'local', path: 'templates/software-full' },
    },
    {
      ...MOCK_TOOL_META,
      downloads: 0,
      source: { type: 'local', path: 'plugins/repo-manager' },
    },
  ],
};

const MOCK_TEMPLATE_META_WITH_DEPS = {
  ...MOCK_INDEX_WITH_DEPS.packages[0],
  dependencies: {
    plugins: { required: ['repo-manager'] as string[] },
  },
};

const MOCK_INDEX_WITH_RECOMMENDED = {
  ...MOCK_INDEX_WITH_DEPS,
  packages: [
    ...MOCK_INDEX_WITH_DEPS.packages,
    {
      ...MOCK_TOOL_META,
      name: 'shell',
      downloads: 0,
      source: { type: 'local', path: 'plugins/shell' },
    },
  ],
};

const MOCK_TEMPLATE_META_RECOMMENDED = {
  ...MOCK_INDEX_WITH_DEPS.packages[0],
  dependencies: {
    plugins: { recommended: ['repo-manager', 'shell'] as string[] },
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

    vi.stubGlobal('fetch', routedFetch([
      [/\/templates\/software-full\/metadata\.json$/, MOCK_TEMPLATE_META_WITH_DEPS],
      [/\/contents\/templates\/software-full\/project$/, []],
      [/\/plugins\/repo-manager\/metadata\.json$/, MOCK_TOOL_META],
      [/\/contents\/plugins\/repo-manager$/, dirListing('plugins/repo-manager', 'repo-manager.tool.yaml')],
      [/x\/repo-manager\.tool\.yaml$/, 'name: repo_manager\n'],
      [/x\/metadata\.json$/, JSON.stringify(MOCK_TOOL_META)],
    ]));

    const { installPackage } = await import('../../../src/commands/registry/install.js');
    await installPackage('software-full', { studioDir: STUDIO_DIR, force: true });

    const lf = JSON.parse(await readFile(resolve(STUDIO_DIR, 'registry.lock.json'), 'utf8'));
    expect(lf.installed['software-full']).toMatchObject({ files: ['projects/software-full'] });
    expect(lf.installed['repo-manager']).toMatchObject({ files: ['tools/repo-manager.tool.yaml'] });
    expect(lf.installed['repo-manager'].required_by).toEqual(['software-full']);
  });

  it('prompts for each recommended plugin and installs only the accepted ones (STU-693)', async () => {
    vi.doMock('../../../src/registry/cache.js', () => {
      class RegistryCache {
        read() { return Promise.resolve(MOCK_INDEX_WITH_RECOMMENDED); }
        write() { return Promise.resolve(undefined); }
        isFresh() { return Promise.resolve(true); }
      }
      return { RegistryCache };
    });
    vi.doMock('../../../src/commands/registry/sync.js', () => ({
      syncRegistry: vi.fn().mockResolvedValue(undefined),
    }));
    const confirm = vi.fn()
      .mockResolvedValueOnce(true)    // repo-manager
      .mockResolvedValueOnce(false);  // shell
    vi.doMock('@inquirer/prompts', () => ({ confirm }));

    vi.stubGlobal('fetch', routedFetch([
      [/\/templates\/software-full\/metadata\.json$/, MOCK_TEMPLATE_META_RECOMMENDED],
      [/\/contents\/templates\/software-full\/project$/, []],
      [/\/plugins\/repo-manager\/metadata\.json$/, MOCK_TOOL_META],
      [/\/contents\/plugins\/repo-manager$/, dirListing('plugins/repo-manager', 'repo-manager.tool.yaml')],
      [/x\/repo-manager\.tool\.yaml$/, 'name: repo_manager\n'],
      [/x\/metadata\.json$/, JSON.stringify(MOCK_TOOL_META)],
    ]));

    const { installPackage } = await import('../../../src/commands/registry/install.js');
    await installPackage('software-full', { studioDir: STUDIO_DIR, force: true });

    expect(confirm).toHaveBeenCalledTimes(2);
    const lf = JSON.parse(await readFile(resolve(STUDIO_DIR, 'registry.lock.json'), 'utf8'));
    expect(lf.installed['repo-manager']).toBeDefined();
    expect(lf.installed['shell']).toBeUndefined();
  });

  it('updates required_by if dep already installed', async () => {
    // Pre-install repo-manager in the lockfile
    await mkdir(resolve(STUDIO_DIR, 'tools'), { recursive: true });
    await writeFile(resolve(STUDIO_DIR, 'tools', 'repo-manager.tool.yaml'), 'name: repo_manager\n');
    await writeFile(resolve(STUDIO_DIR, 'registry.lock.json'), JSON.stringify({
      installed: {
        'repo-manager': { version: '1.0.0', type: 'plugin', installed_at: '2026-02-28', sha256: 'abc' },
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

    vi.stubGlobal('fetch', routedFetch([
      [/\/templates\/software-full\/metadata\.json$/, MOCK_TEMPLATE_META_WITH_DEPS],
      [/\/contents\/templates\/software-full\/project$/, []],
      [/\/plugins\/repo-manager\/metadata\.json$/, MOCK_TOOL_META],
    ]));

    const { installPackage } = await import('../../../src/commands/registry/install.js');
    await installPackage('software-full', { studioDir: STUDIO_DIR, force: true });

    const lf = JSON.parse(await readFile(resolve(STUDIO_DIR, 'registry.lock.json'), 'utf8'));
    // repo-manager was not reinstalled but required_by updated
    expect(lf.installed['repo-manager'].required_by).toContain('software-full');
  });
});

// --- Payload hosted outside the marketplace repo (STU-694) ---

const GIT_CHECKOUT = resolve(TMP, 'git-checkout');

const MOCK_GIT_META = {
  name: 'legal-analysis',
  type: 'plugin',
  version: '2.1.0',
  description: 'Legal analysis plugin',
  author: 'someone',
  license: 'MIT',
  tags: [] as string[],
  studio_version: '>=0.1.0',
  provides: { agents: ['legal'] },
};

const MOCK_GIT_INDEX = {
  generated_at: '2026-02-28T00:00:00Z',
  version: '1',
  packages: [{
    ...MOCK_GIT_META,
    downloads: 0,
    source: {
      type: 'git',
      url: 'https://github.com/someone/studio-legal.git',
      path: 'plugin',
      ref: 'v2.1.0',
      sha: '9f3c1a',
    },
  }],
};

const MIT_TEXT = 'MIT License\n\nPermission is hereby granted, free of charge…\n';

async function writeGitPayload(files: Record<string, string>): Promise<void> {
  await mkdir(resolve(GIT_CHECKOUT, 'plugin'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(resolve(GIT_CHECKOUT, 'plugin', name), content);
  }
  vi.doMock('../../../src/registry/git-source.js', () => ({
    materializeGit: vi.fn().mockResolvedValue(GIT_CHECKOUT),
  }));
  vi.doMock('../../../src/registry/cache.js', () => {
    class RegistryCache {
      read() { return Promise.resolve(MOCK_GIT_INDEX); }
      write() { return Promise.resolve(undefined); }
      isFresh() { return Promise.resolve(true); }
    }
    return { RegistryCache };
  });
  vi.doMock('../../../src/commands/registry/sync.js', () => ({
    syncRegistry: vi.fn().mockResolvedValue(undefined),
  }));
}

describe('installPackage — git source', () => {
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

  it('installs the payload fetched at the pinned commit', async () => {
    await writeGitPayload({
      'metadata.json': JSON.stringify(MOCK_GIT_META),
      'LICENSE': MIT_TEXT,
      'legal.agent.yaml': 'name: legal\n',
    });

    const { installPackage } = await import('../../../src/commands/registry/install.js');
    await installPackage('legal-analysis', { studioDir: STUDIO_DIR, force: true });

    expect(await readFile(resolve(STUDIO_DIR, 'agents', 'legal.agent.yaml'), 'utf8')).toBe('name: legal\n');
    // The LICENSE is proof, not content: it is verified and then left behind.
    const lf = JSON.parse(await readFile(resolve(STUDIO_DIR, 'registry.lock.json'), 'utf8'));
    expect(lf.installed['legal-analysis'].files).toEqual(['agents/legal.agent.yaml']);
  });

  it('refuses a payload whose LICENSE does not match the entry', async () => {
    await writeGitPayload({
      'metadata.json': JSON.stringify(MOCK_GIT_META),
      'LICENSE': 'GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007\n',
      'legal.agent.yaml': 'name: legal\n',
    });

    const { installPackage } = await import('../../../src/commands/registry/install.js');
    await expect(installPackage('legal-analysis', { studioDir: STUDIO_DIR, force: true }))
      .rejects.toThrow(/LICENSE file that is not 'MIT'/);
  });

  it('refuses a payload shipping content its entry does not declare', async () => {
    await writeGitPayload({
      'metadata.json': JSON.stringify(MOCK_GIT_META),
      'LICENSE': MIT_TEXT,
      'legal.agent.yaml': 'name: legal\n',
      'exfiltrate.tool.yaml': 'name: exfiltrate\n',
    });

    const { installPackage } = await import('../../../src/commands/registry/install.js');
    await expect(installPackage('legal-analysis', { studioDir: STUDIO_DIR, force: true }))
      .rejects.toThrow(/ships undeclared tool 'exfiltrate'/);
  });
});
