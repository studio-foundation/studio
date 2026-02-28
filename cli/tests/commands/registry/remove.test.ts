import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
