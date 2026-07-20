import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalize,
  hashItemInput,
  FileSystemMapItemCache,
  InMemoryMapItemCache,
  type MapCacheNamespace,
} from '../../src/pipeline/map-item-cache.js';

const NS: MapCacheNamespace = { pipeline: 'wiki', stage: 'generate', subPipeline: 'page-item' };

describe('map-item-cache — hashing', () => {
  it('hashes on input, so object key order does not matter', () => {
    expect(hashItemInput({ a: 1, b: 2 })).toBe(hashItemInput({ b: 2, a: 1 }));
  });

  it('changing an input value changes the hash', () => {
    expect(hashItemInput({ entity: 'Alice' })).not.toBe(hashItemInput({ entity: 'Bob' }));
  });

  it('array order is significant (a list is ordered data)', () => {
    expect(hashItemInput([1, 2])).not.toBe(hashItemInput([2, 1]));
  });

  it('canonicalize ignores undefined fields and sorts keys', () => {
    expect(canonicalize({ b: 1, a: undefined, c: 3 })).toBe('{"b":1,"c":3}');
  });
});

describe('FileSystemMapItemCache', () => {
  let dir: string;
  let cache: FileSystemMapItemCache;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'map-cache-'));
    cache = new FileSystemMapItemCache(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined on a miss', async () => {
    expect(await cache.get(NS, hashItemInput({ x: 1 }))).toBeUndefined();
  });

  it('round-trips a stored item', async () => {
    const h = hashItemInput({ entity: 'Alice' });
    await cache.set(NS, h, { output: { page: 'Alice' }, run_id: 'r1', cached_at: '2026-01-01T00:00:00Z' });
    const got = await cache.get(NS, h);
    expect(got).toEqual({ output: { page: 'Alice' }, run_id: 'r1', cached_at: '2026-01-01T00:00:00Z' });
  });

  it('isolates entries by namespace (pipeline/stage/subPipeline)', async () => {
    const h = hashItemInput({ entity: 'Alice' });
    await cache.set(NS, h, { output: 1, cached_at: 'x' });
    const otherStage: MapCacheNamespace = { ...NS, stage: 'classify' };
    expect(await cache.get(otherStage, h)).toBeUndefined();
  });

  it('survives a fresh cache instance over the same root (persistence)', async () => {
    const h = hashItemInput({ entity: 'Alice' });
    await cache.set(NS, h, { output: 42, cached_at: 'x' });
    const reopened = new FileSystemMapItemCache(dir);
    expect((await reopened.get(NS, h))?.output).toBe(42);
  });

  it('a namespace with path-hostile characters is still storable', async () => {
    const weird: MapCacheNamespace = { pipeline: 'a/b', stage: '../x', subPipeline: 'c d' };
    const h = hashItemInput({ n: 1 });
    await cache.set(weird, h, { output: 'ok', cached_at: 'x' });
    expect((await cache.get(weird, h))?.output).toBe('ok');
  });
});

describe('InMemoryMapItemCache', () => {
  it('round-trips and isolates by namespace', async () => {
    const cache = new InMemoryMapItemCache();
    const h = hashItemInput({ entity: 'Alice' });
    await cache.set(NS, h, { output: 'a', cached_at: 'x' });
    expect((await cache.get(NS, h))?.output).toBe('a');
    expect(await cache.get({ ...NS, stage: 'other' }, h)).toBeUndefined();
  });
});
