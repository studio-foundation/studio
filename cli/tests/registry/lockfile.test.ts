import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RegistryLockfile } from '../../src/registry/lockfile.js';

const TMP = resolve(import.meta.dirname, '.tmp-lockfile');

beforeEach(async () => { await mkdir(TMP, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

describe('RegistryLockfile', () => {
  it('returns empty lockfile when file does not exist', async () => {
    const lf = new RegistryLockfile(TMP);
    const data = await lf.read();
    expect(data.installed).toEqual({});
  });

  it('adds a package entry', async () => {
    const lf = new RegistryLockfile(TMP);
    await lf.add('software', {
      version: '1.0.0',
      type: 'template',
      installed_at: '2026-02-28',
      sha256: 'abc123',
    });
    const data = await lf.read();
    expect(data.installed['software']).toMatchObject({
      version: '1.0.0',
      type: 'template',
      sha256: 'abc123',
    });
  });

  it('removes a package entry', async () => {
    const lf = new RegistryLockfile(TMP);
    await lf.add('software', { version: '1.0.0', type: 'template', installed_at: '2026-02-28', sha256: 'abc' });
    await lf.remove('software');
    const data = await lf.read();
    expect(data.installed['software']).toBeUndefined();
  });

  it('lists installed packages', async () => {
    const lf = new RegistryLockfile(TMP);
    await lf.add('software', { version: '1.0.0', type: 'template', installed_at: '2026-02-28', sha256: 'abc' });
    await lf.add('linear', { version: '1.0.0', type: 'integration', installed_at: '2026-02-28', sha256: 'def' });
    const list = await lf.list();
    expect(list).toHaveLength(2);
    expect(list.map(e => e.name)).toContain('software');
    expect(list.map(e => e.name)).toContain('linear');
  });
});
