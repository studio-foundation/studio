import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

// Use /tmp as base to avoid interference from the Studio repo's own .studio/
const TMP = resolve('/tmp', '.studio-init-test');

beforeEach(async () => { await mkdir(TMP, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe('createStudioStructure', () => {
  it('creates .studio/ directory structure', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    expect(await exists(resolve(TMP, '.studio'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'config.yaml'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'pipelines'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'agents'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'contracts'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'tools'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'inputs'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'runs', 'logs'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'registry.lock.json'))).toBe(true);
  });

  it('adds .studio/config.yaml and .studio/runs/ to .gitignore', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    const gitignore = await readFile(resolve(TMP, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.studio/config.yaml');
    expect(gitignore).toContain('.studio/runs/');
  });

  it('appends to existing .gitignore without duplicating', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    const gitignorePath = resolve(TMP, '.gitignore');
    await writeFile(gitignorePath, 'node_modules/\n.studio/config.yaml\n');

    await createStudioStructure(TMP);

    const content = await readFile(gitignorePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim() === '.studio/config.yaml');
    expect(lines.length).toBe(1); // no duplicate
  });

  it('creates named project structure when projectName provided', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP, 'software');

    expect(await exists(resolve(TMP, '.studio', 'projects', 'software', 'pipelines'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'software', 'agents'))).toBe(true);
  });

  it('writes empty registry.lock.json', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    const content = await readFile(resolve(TMP, '.studio', 'registry.lock.json'), 'utf-8');
    expect(JSON.parse(content)).toEqual({});
  });
});

describe('initCommand already initialized', () => {
  it('throws when .studio/ already exists', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    // First init
    await createStudioStructure(TMP);
    // Second init should throw
    await expect(createStudioStructure(TMP)).rejects.toThrow('already initialized');
  });

  it('error message includes path to the found .studio/', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);
    try {
      await createStudioStructure(TMP);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err instanceof Error && err.message).toContain('.studio');
    }
  });
});
