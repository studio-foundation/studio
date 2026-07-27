import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { RegistryLockfile } from '../../src/registry/lockfile.js';

const TMP = resolve(import.meta.dirname, '.tmp-lockfile');
const STUDIO = join(TMP, '.studio');

beforeEach(async () => { await mkdir(STUDIO, { recursive: true }); });
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

describe('RegistryLockfile.addRequiredBy', () => {
  it('adds required_by to an existing entry', async () => {
    const { RegistryLockfile } = await import('../../src/registry/lockfile.js');
    const lf = new RegistryLockfile(STUDIO);
    await lf.add('repo-manager', { version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256: 'abc' });

    await lf.addRequiredBy('repo-manager', 'software-full');

    const entry = await lf.get('repo-manager');
    expect(entry?.required_by).toEqual(['software-full']);
  });

  it('does not duplicate if already present', async () => {
    const { RegistryLockfile } = await import('../../src/registry/lockfile.js');
    const lf = new RegistryLockfile(STUDIO);
    await lf.add('repo-manager', { version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256: 'abc', required_by: ['software-full'] });

    await lf.addRequiredBy('repo-manager', 'software-full');

    const entry = await lf.get('repo-manager');
    expect(entry?.required_by).toEqual(['software-full']); // still just one
  });

  it('removes from required_by with removeRequiredBy', async () => {
    const { RegistryLockfile } = await import('../../src/registry/lockfile.js');
    const lf = new RegistryLockfile(STUDIO);
    await lf.add('repo-manager', { version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256: 'abc', required_by: ['software-full', 'other-pkg'] });

    await lf.removeRequiredBy('repo-manager', 'software-full');

    const entry = await lf.get('repo-manager');
    expect(entry?.required_by).toEqual(['other-pkg']);
  });
});

describe('RegistryLockfile constraints (STU-203)', () => {
  it('records the range a dependent declared', async () => {
    const lf = new RegistryLockfile(STUDIO);
    await lf.add('git', { version: '1.4.0', type: 'plugin', installed_at: '2026-07-27', sha256: 'abc' });

    await lf.addRequiredBy('git', 'software', '>=1.0.0 <2.0.0');

    expect((await lf.get('git'))?.constraints).toEqual({ software: '>=1.0.0 <2.0.0' });
  });

  it('leaves no constraint when the dependent declared no range', async () => {
    const lf = new RegistryLockfile(STUDIO);
    await lf.add('git', { version: '1.4.0', type: 'plugin', installed_at: '2026-07-27', sha256: 'abc' });

    await lf.addRequiredBy('git', 'software');

    expect((await lf.get('git'))?.constraints).toBeUndefined();
  });

  it('drops the constraint along with the dependent', async () => {
    const lf = new RegistryLockfile(STUDIO);
    await lf.add('git', {
      version: '1.4.0', type: 'plugin', installed_at: '2026-07-27', sha256: 'abc',
      required_by: ['software', 'deploy-kit'], constraints: { software: '<2.0.0', 'deploy-kit': '>=1.0.0' },
    });

    await lf.removeRequiredBy('git', 'software');

    expect((await lf.get('git'))?.constraints).toEqual({ 'deploy-kit': '>=1.0.0' });
  });

  it('keeps dependents and constraints across a --force reinstall', async () => {
    const lf = new RegistryLockfile(STUDIO);
    await lf.add('git', {
      version: '1.0.0', type: 'plugin', installed_at: '2026-07-27', sha256: 'abc',
      required_by: ['software'], constraints: { software: '<2.0.0' },
    });

    await lf.add('git', { version: '1.4.0', type: 'plugin', installed_at: '2026-07-28', sha256: 'def' });

    const entry = await lf.get('git');
    expect(entry).toMatchObject({ version: '1.4.0', sha256: 'def', required_by: ['software'] });
    expect(entry?.constraints).toEqual({ software: '<2.0.0' });
  });
});
