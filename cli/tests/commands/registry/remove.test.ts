import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const TMP = resolve(import.meta.dirname, '.tmp-remove');
const STUDIO = join(TMP, '.studio');

beforeEach(async () => {
  await mkdir(resolve(STUDIO, 'tools'), { recursive: true });
  await writeFile(resolve(STUDIO, 'tools', 'my-tool.tool.yaml'), 'name: my-tool\n');
  await writeFile(resolve(STUDIO, 'registry.lock.json'), JSON.stringify({
    installed: {
      'my-tool': { version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256: 'abc' },
    },
  }));
});
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

describe('removePackage', () => {
  it('removes the file and lockfile entry', async () => {
    const { removePackage } = await import('../../../src/commands/registry/remove.js');
    await removePackage('my-tool', { studioDir: STUDIO });
    const lf = JSON.parse(await readFile(resolve(STUDIO, 'registry.lock.json'), 'utf8'));
    expect(lf.installed['my-tool']).toBeUndefined();
  });

  it('errors if package not installed', async () => {
    const { removePackage } = await import('../../../src/commands/registry/remove.js');
    await expect(removePackage('nonexistent', { studioDir: STUDIO })).rejects.toThrow('not installed');
  });
});

describe('removePackage — dependents warning', () => {
  beforeEach(async () => {
    await mkdir(resolve(STUDIO, 'tools'), { recursive: true });
    await writeFile(resolve(STUDIO, 'tools', 'repo-manager.tool.yaml'), 'name: repo_manager\n');
    await writeFile(resolve(STUDIO, 'registry.lock.json'), JSON.stringify({
      installed: {
        'repo-manager': {
          version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256: 'abc',
          required_by: ['software-full'],
        },
      },
    }));
  });
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('warns about the broken references and removes anyway', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { removePackage } = await import('../../../src/commands/registry/remove.js');
    await removePackage('repo-manager', { studioDir: STUDIO });

    const printed = log.mock.calls.map(c => String(c[0])).join('\n');
    expect(printed).toMatch(/required by.*software-full/i);
    const lf = JSON.parse(await readFile(resolve(STUDIO, 'registry.lock.json'), 'utf8'));
    expect(lf.installed['repo-manager']).toBeUndefined();
  });
});

describe('removePackage — orphan cleanup', () => {
  beforeEach(async () => {
    await mkdir(resolve(STUDIO, 'tools'), { recursive: true });
    await mkdir(resolve(STUDIO, 'projects', 'software-full'), { recursive: true });
    await writeFile(resolve(STUDIO, 'tools', 'repo-manager.tool.yaml'), 'name: repo_manager\n');
    await writeFile(resolve(STUDIO, 'registry.lock.json'), JSON.stringify({
      installed: {
        'software-full': {
          version: '2.0.0', type: 'template', installed_at: '2026-02-28', sha256: 'def',
          required_by: [],
        },
        'repo-manager': {
          version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256: 'abc',
          required_by: ['software-full'],
        },
      },
    }));
  });
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('prompts about orphans and removes them when confirmed', async () => {
    vi.doMock('@inquirer/prompts', () => ({ confirm: vi.fn().mockResolvedValue(true) }));
    vi.resetModules();
    const { removePackage } = await import('../../../src/commands/registry/remove.js');
    await removePackage('software-full', { studioDir: STUDIO });

    const lf = JSON.parse(await readFile(resolve(STUDIO, 'registry.lock.json'), 'utf8'));
    expect(lf.installed['software-full']).toBeUndefined();
    expect(lf.installed['repo-manager']).toBeUndefined();
  });

  it('leaves orphans installed when user declines', async () => {
    vi.doMock('@inquirer/prompts', () => ({ confirm: vi.fn().mockResolvedValue(false) }));
    vi.resetModules();
    const { removePackage } = await import('../../../src/commands/registry/remove.js');
    await removePackage('software-full', { studioDir: STUDIO });

    const lf = JSON.parse(await readFile(resolve(STUDIO, 'registry.lock.json'), 'utf8'));
    expect(lf.installed['software-full']).toBeUndefined();
    expect(lf.installed['repo-manager']).toBeDefined();
  });
});
