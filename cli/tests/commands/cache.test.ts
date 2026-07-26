import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cacheCleanCommand } from '../../src/commands/cache.js';

// /tmp, never a subdir of the repo — the Studio repo has its own .studio/ at the
// root, so findStudioDir() would walk up and find that one instead.
const TMP = resolve('/tmp', '.studio-cache-clean-test');
const MAP_CACHE = join(TMP, '.studio', 'runs', 'map-cache');

async function seedItem(pipeline: string, stage: string, subPipeline: string, hash: string): Promise<void> {
  const dir = join(MAP_CACHE, pipeline, stage, subPipeline);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${hash}.json`), JSON.stringify({ output: {}, cached_at: '2026-01-01' }));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('studio cache clean', () => {
  const cwd = process.cwd();
  let logs: string[];

  beforeEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    await mkdir(join(TMP, '.studio'), { recursive: true });
    process.chdir(TMP);
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((msg: unknown) => { logs.push(String(msg)); });
  });

  afterEach(async () => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    await rm(TMP, { recursive: true, force: true });
  });

  it('clears the whole map cache and reports the item count', async () => {
    await seedItem('wiki', 'pages', 'wiki-page', 'aaa');
    await seedItem('wiki', 'pages', 'wiki-page', 'bbb');
    await seedItem('other', 'items', 'sub', 'ccc');

    await cacheCleanCommand({});

    expect(await exists(MAP_CACHE)).toBe(false);
    expect(logs.join('\n')).toContain('Cleared 3 cached map item(s)');
  });

  it('scopes deletion to one pipeline with --pipeline', async () => {
    await seedItem('wiki', 'pages', 'wiki-page', 'aaa');
    await seedItem('other', 'items', 'sub', 'ccc');

    await cacheCleanCommand({ pipeline: 'wiki' });

    expect(await exists(join(MAP_CACHE, 'wiki'))).toBe(false);
    expect(await exists(join(MAP_CACHE, 'other'))).toBe(true);
    expect(logs.join('\n')).toContain('Cleared 1 cached map item(s)');
  });

  it('resolves --pipeline through the same path sanitization as the cache writer', async () => {
    await seedItem('my_pipeline', 'pages', 'sub', 'aaa');

    await cacheCleanCommand({ pipeline: 'my/pipeline' });

    expect(await exists(join(MAP_CACHE, 'my_pipeline'))).toBe(false);
  });

  it('deletes nothing with --dry-run', async () => {
    await seedItem('wiki', 'pages', 'wiki-page', 'aaa');

    await cacheCleanCommand({ dryRun: true });

    expect(await exists(join(MAP_CACHE, 'wiki'))).toBe(true);
    expect(logs.join('\n')).toContain('Would clear 1 cached map item(s)');
  });

  it('reports an empty cache instead of failing', async () => {
    await cacheCleanCommand({});

    expect(logs.join('\n')).toContain('Map cache already empty');
  });
});
