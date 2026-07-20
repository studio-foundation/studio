import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PipelineEngine } from '../../src/engine.js';
import { InMemoryRunStore } from '../../src/state/run-store.js';
import type { EngineEvents } from '../../src/events.js';
import type {
  PipelineDefinition,
  RunSpawner,
  SpawnConfig,
  SpawnResult,
} from '@studio-foundation/contracts';

/** Records calls and returns/throws per handler, so each run gets a fresh call log. */
class FakeSpawner implements RunSpawner {
  calls: SpawnConfig[] = [];
  constructor(private handler: (c: SpawnConfig, i: number) => Promise<SpawnResult> | SpawnResult) {}
  async spawnAndWait(config: SpawnConfig): Promise<SpawnResult> {
    const i = this.calls.length;
    this.calls.push(config);
    return this.handler(config, i);
  }
}

const ok = (runId: string, output: unknown): SpawnResult => ({ run_id: runId, status: 'success', output });

/** One-stage map pipeline over input.items, item wrapped under `entity`. */
function mapPipeline(overrides: Record<string, unknown> = {}): PipelineDefinition {
  return {
    name: 'resume-test',
    description: 'resume test',
    version: 1,
    stages: [
      { map: 'generate', over: 'input.items', pipeline: 'child', as: 'entity', resume: true, ...overrides } as any,
    ],
  };
}

describe('Fan-out (map) — per-item resume', () => {
  let dir: string;
  const makeEngine = (spawner: RunSpawner, events?: EngineEvents) =>
    new PipelineEngine(
      { configsDir: dir, providerRegistry: { get: vi.fn(), register: vi.fn() } as any, db: new InMemoryRunStore(), spawner },
      events,
    );

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'map-resume-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('re-runs only the incomplete items after an interrupted run', async () => {
    // Run 1 (collect-all): 'b' fails, 'a' and 'c' complete and get cached.
    const spawner1 = new FakeSpawner((c) => {
      const entity = (c.input as any).entity;
      if (entity === 'b') throw new Error('boom');
      return ok(`r-${entity}`, { page: entity });
    });
    const r1 = await makeEngine(spawner1).run({
      pipelineDef: mapPipeline({ on_item_failure: 'collect-all' }),
      input: { items: ['a', 'b', 'c'] },
    });
    expect(r1.status).toBe('success');
    expect(spawner1.calls.map((c) => (c.input as any).entity).sort()).toEqual(['a', 'b', 'c']);

    // Run 2: everything succeeds. Only the previously-failed 'b' is re-spawned.
    const spawner2 = new FakeSpawner((c) => ok(`r2-${(c.input as any).entity}`, { page: (c.input as any).entity }));
    const r2 = await makeEngine(spawner2).run({
      pipelineDef: mapPipeline({ on_item_failure: 'collect-all' }),
      input: { items: ['a', 'b', 'c'] },
    });

    expect(r2.status).toBe('success');
    expect(spawner2.calls.map((c) => (c.input as any).entity)).toEqual(['b']);

    const out = r2.stages[0].output as any;
    expect(out.total).toBe(3);
    expect(out.succeeded).toBe(3);
    expect(out.resumed).toBe(2); // a and c served from cache
    // Outputs preserve index order regardless of which were cached.
    expect(out.outputs).toEqual([{ page: 'a' }, { page: 'b' }, { page: 'c' }]);
  });

  it('a failed item is not cached and retries on the next run', async () => {
    const spawner1 = new FakeSpawner((c) => {
      if ((c.input as any).entity === 'a') throw new Error('a failed');
      return ok('r', { page: (c.input as any).entity });
    });
    await makeEngine(spawner1).run({
      pipelineDef: mapPipeline({ on_item_failure: 'collect-all' }),
      input: { items: ['a', 'b'] },
    });

    // 'a' was never cached → run 2 must re-spawn it (and not 'b').
    const spawner2 = new FakeSpawner((c) => ok('r2', { page: (c.input as any).entity }));
    await makeEngine(spawner2).run({
      pipelineDef: mapPipeline({ on_item_failure: 'collect-all' }),
      input: { items: ['a', 'b'] },
    });
    expect(spawner2.calls.map((c) => (c.input as any).entity)).toEqual(['a']);
  });

  it('reordering the list still hits the cache; nothing re-spawns', async () => {
    const spawner1 = new FakeSpawner((c) => ok('r', { page: (c.input as any).entity }));
    await makeEngine(spawner1).run({ pipelineDef: mapPipeline(), input: { items: ['a', 'b', 'c'] } });
    expect(spawner1.calls).toHaveLength(3);

    // Same items, different order → all served from cache, spawner untouched.
    const spawner2 = new FakeSpawner((c) => ok('r2', { page: (c.input as any).entity }));
    const r2 = await makeEngine(spawner2).run({ pipelineDef: mapPipeline(), input: { items: ['c', 'a', 'b'] } });

    expect(spawner2.calls).toHaveLength(0);
    const out = r2.stages[0].output as any;
    expect(out.resumed).toBe(3);
    // Output order follows the (reordered) input list.
    expect(out.outputs).toEqual([{ page: 'c' }, { page: 'a' }, { page: 'b' }]);
  });

  it('changing an item input invalidates only that item', async () => {
    const spawner1 = new FakeSpawner((c) => ok('r', { v: (c.input as any).entity.v }));
    await makeEngine(spawner1).run({
      pipelineDef: mapPipeline(),
      input: { items: [{ id: 'x', v: 1 }, { id: 'y', v: 1 }] },
    });

    // 'x' keeps v:1 (cache hit); 'y' changes to v:2 (cache miss → re-spawn).
    const spawner2 = new FakeSpawner((c) => ok('r2', { v: (c.input as any).entity.v }));
    await makeEngine(spawner2).run({
      pipelineDef: mapPipeline(),
      input: { items: [{ id: 'x', v: 1 }, { id: 'y', v: 2 }] },
    });

    expect(spawner2.calls.map((c) => (c.input as any).entity.id)).toEqual(['y']);
  });

  it('resume is opt-in: without resume:true nothing is cached', async () => {
    const spawner1 = new FakeSpawner((c) => ok('r', { page: (c.input as any).entity }));
    await makeEngine(spawner1).run({ pipelineDef: mapPipeline({ resume: false }), input: { items: ['a', 'b'] } });

    const spawner2 = new FakeSpawner((c) => ok('r2', { page: (c.input as any).entity }));
    const r2 = await makeEngine(spawner2).run({ pipelineDef: mapPipeline({ resume: false }), input: { items: ['a', 'b'] } });

    expect(spawner2.calls).toHaveLength(2); // both re-spawned
    expect((r2.stages[0].output as any).resumed).toBe(0);
  });

  it('marks cache-served items in the item-complete event', async () => {
    const spawner1 = new FakeSpawner((c) => ok('r', { page: (c.input as any).entity }));
    await makeEngine(spawner1).run({ pipelineDef: mapPipeline(), input: { items: ['a'] } });

    const cachedFlags: Array<boolean | undefined> = [];
    const spawner2 = new FakeSpawner((c) => ok('r2', { page: (c.input as any).entity }));
    await makeEngine(spawner2, {
      onMapItemComplete: (e) => cachedFlags.push(e.cached),
    }).run({ pipelineDef: mapPipeline(), input: { items: ['a'] } });

    expect(spawner2.calls).toHaveLength(0);
    expect(cachedFlags).toEqual([true]);
  });

  it('fail-fast: cached successes never trip the abort; only a fresh failure does', async () => {
    // Run 1 sequential fail-fast: 'a' ok (cached), 'b' fails → 'c' never launched.
    const spawner1 = new FakeSpawner((c) => {
      const e = (c.input as any).entity;
      if (e === 'b') throw new Error('boom');
      return ok('r', { page: e });
    });
    const r1 = await makeEngine(spawner1).run({
      pipelineDef: mapPipeline({ concurrency: 1, on_item_failure: 'fail-fast' }),
      input: { items: ['a', 'b', 'c'] },
    });
    expect(r1.status).toBe('failed');
    expect(spawner1.calls.map((c) => (c.input as any).entity)).toEqual(['a', 'b']); // c never reached

    // Run 2: 'a' is cached (no spawn), 'b' now succeeds, so 'c' finally runs.
    const spawner2 = new FakeSpawner((c) => ok('r2', { page: (c.input as any).entity }));
    const r2 = await makeEngine(spawner2).run({
      pipelineDef: mapPipeline({ concurrency: 1, on_item_failure: 'fail-fast' }),
      input: { items: ['a', 'b', 'c'] },
    });
    expect(r2.status).toBe('success');
    expect(spawner2.calls.map((c) => (c.input as any).entity)).toEqual(['b', 'c']);
    expect((r2.stages[0].output as any).resumed).toBe(1);
  });
});
