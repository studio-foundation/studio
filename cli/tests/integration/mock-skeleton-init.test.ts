/**
 * STU-1540: init must survive a mock.yaml generator failure, and every seeded
 * template must come out of init with a parseable mock.yaml.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import * as yaml from 'js-yaml';

const TMP = resolve('/tmp', '.studio-mock-skeleton-init-test');
const SEED_TEMPLATES = resolve(import.meta.dirname, '../../templates/seed/templates');

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.doUnmock('../../src/mock-skeleton.js');
  vi.resetModules();
});

describe('mock.yaml generation during init', () => {
  it('still inits when the generator throws on an unreadable contract', async () => {
    await mkdir(TMP, { recursive: true });
    vi.doMock('../../src/mock-skeleton.js', () => ({
      writeMockSkeleton: () => Promise.reject(new Error('contract unreadable')),
    }));
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await expect(createStudioStructure(TMP, 'blank')).resolves.toBeUndefined();
    await expect(readFile(join(TMP, '.studio', 'config.yaml'), 'utf-8')).resolves.toBeDefined();
  });

  it('writes a parseable mock.yaml for every seeded template', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')));
    const { createStudioStructure } = await import('../../src/commands/init.js');
    const templates = await readdir(SEED_TEMPLATES);
    expect(templates.length).toBeGreaterThan(1);
    for (const template of templates) {
      const cwd = join(TMP, template);
      await mkdir(cwd, { recursive: true });
      await createStudioStructure(cwd, template);
      const doc = yaml.load(await readFile(join(cwd, '.studio', 'mock.yaml'), 'utf-8')) as { stages: Record<string, unknown> };
      expect(Object.keys(doc.stages).length, template).toBeGreaterThan(0);
    }
  }, 60_000);
});
