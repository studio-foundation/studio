import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const TMP = resolve('/tmp', '.studio-client-git-test');
const CHECKOUT = resolve(TMP, 'checkout');

const GIT_SOURCE = {
  type: 'git' as const,
  url: 'https://github.com/someone/studio-legal.git',
  path: 'plugin',
  ref: 'v2.1.0',
  sha: '9f3c1a',
};

beforeEach(async () => {
  await mkdir(resolve(CHECKOUT, 'plugin', 'nested'), { recursive: true });
  await writeFile(resolve(CHECKOUT, 'README.md'), 'outside the package dir\n');
  await writeFile(resolve(CHECKOUT, 'plugin', 'metadata.json'), '{"name":"legal-analysis"}');
  await writeFile(resolve(CHECKOUT, 'plugin', 'nested', 'legal.agent.yaml'), 'name: legal\n');
  vi.doMock('../../src/registry/git-source.js', () => ({
    materializeGit: vi.fn().mockResolvedValue(CHECKOUT),
  }));
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('RegistryClient with a git source', () => {
  it('reads the package directory at source.path, not the repository root', async () => {
    const { RegistryClient } = await import('../../src/registry/client.js');
    const files = await new RegistryClient().fetchDirectoryFiles(GIT_SOURCE);
    expect(files).toEqual([
      { path: 'metadata.json', content: '{"name":"legal-analysis"}' },
      { path: 'nested/legal.agent.yaml', content: 'name: legal\n' },
    ]);
  });

  it('reads metadata from the checkout', async () => {
    const { RegistryClient } = await import('../../src/registry/client.js');
    const meta = await new RegistryClient().fetchMetadata(GIT_SOURCE, 'legal-analysis');
    expect(meta.name).toBe('legal-analysis');
  });

  it('passes the pinned checkout through to the fetcher', async () => {
    const { materializeGit } = await import('../../src/registry/git-source.js');
    const { RegistryClient } = await import('../../src/registry/client.js');
    await new RegistryClient().fetchDirectoryFiles(GIT_SOURCE);
    expect(vi.mocked(materializeGit)).toHaveBeenCalledWith(GIT_SOURCE);
  });
});
