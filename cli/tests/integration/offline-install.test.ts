/**
 * Integration test for installing with no network (STU-695).
 *
 * `git` and `search` left the kernel, so `studio init --template software` now
 * depends on the registry for tools that used to be compiled in. The bundled
 * seed is what keeps that working on a machine that cannot reach the network:
 * every fetch here rejects, and the whole graph — template payload, required
 * plugins, transitive plugins — still has to land in `.studio/`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const TMP = resolve('/tmp', '.studio-offline-install-test');
const STUDIO_DIR = join(TMP, '.studio');

beforeEach(async () => {
  await mkdir(STUDIO_DIR, { recursive: true });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')));
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('installing from the seed with no network', () => {
  it('installs a template and every plugin it requires', async () => {
    const { installPackage } = await import('../../src/commands/registry/install.js');
    const { RegistryLockfile } = await import('../../src/registry/lockfile.js');

    await installPackage('software', { studioDir: STUDIO_DIR, interactive: false });

    const installed = (await new RegistryLockfile(STUDIO_DIR).list()).map((e) => e.name);
    expect(installed).toContain('software');
    expect(installed).toContain('git');
    // Transitive: coder is required by the template, search by coder.
    expect(installed).toContain('search');

    const tools = await readdir(join(STUDIO_DIR, 'tools'));
    expect(tools).toContain('git.tool.yaml');
  });

  it('reports a package the seed does not carry', async () => {
    const { installPackage } = await import('../../src/commands/registry/install.js');
    await expect(
      installPackage('nonexistent-package', { studioDir: STUDIO_DIR, interactive: false }),
    ).rejects.toThrow(/not found in registry/);
  });
});
