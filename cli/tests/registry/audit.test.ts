import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { auditPackages } from '../../src/commands/registry/audit.js';
import { RegistryLockfile } from '../../src/registry/lockfile.js';

const STUDIO = resolve('/tmp', '.studio-audit-constraints-test');

async function installPlugin(name: string, version: string, constraints?: Record<string, string>) {
  const relPath = `tools/${name}.tool.yaml`;
  const content = `name: ${name}\n`;
  await mkdir(resolve(STUDIO, 'tools'), { recursive: true });
  await writeFile(resolve(STUDIO, relPath), content);
  await new RegistryLockfile(STUDIO).add(name, {
    version,
    type: 'plugin',
    installed_at: '2026-07-27',
    sha256: createHash('sha256').update(relPath + content).digest('hex'),
    files: [relPath],
    constraints,
  });
}

beforeEach(async () => { await mkdir(STUDIO, { recursive: true }); });
afterEach(async () => { await rm(STUDIO, { recursive: true, force: true }); });

describe('auditPackages — constraint conflicts', () => {
  it('passes a package whose version satisfies every recorded range', async () => {
    await installPlugin('git', '1.4.0', { software: '>=1.0.0 <2.0.0' });
    expect(await auditPackages({ studioDir: STUDIO })).toEqual([
      { name: 'git', ok: true, status: 'ok' },
    ]);
  });

  it('flags a graph that drifted out of range since install', async () => {
    await installPlugin('git', '2.0.0', { software: '<1.5.0' });
    const [result] = await auditPackages({ studioDir: STUDIO });
    expect(result).toMatchObject({ name: 'git', ok: false, status: 'conflict' });
    expect(result.detail).toBe("v2.0.0 does not satisfy '<1.5.0' (required by software)");
  });

  it('reports tampering ahead of a conflict', async () => {
    await installPlugin('git', '2.0.0', { software: '<1.5.0' });
    await writeFile(resolve(STUDIO, 'tools/git.tool.yaml'), 'name: not-git\n');
    expect((await auditPackages({ studioDir: STUDIO }))[0]).toMatchObject({ status: 'tampered' });
  });
});
