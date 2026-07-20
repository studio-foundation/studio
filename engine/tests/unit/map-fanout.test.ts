import { describe, it, expect, vi } from 'vitest';
import { PipelineEngine } from '../../src/engine.js';
import { InMemoryRunStore } from '../../src/state/run-store.js';
import type { EngineEvents } from '../../src/events.js';
import type {
  PipelineDefinition,
  RunSpawner,
  SpawnConfig,
  SpawnResult,
} from '@studio-foundation/contracts';

const PROJECT_DIR = '/tmp/map-fanout-nonexistent'; // pipelineDef is used, so no files are read

/** A configurable in-process spawner stub — records calls, returns/throws per handler. */
class FakeSpawner implements RunSpawner {
  calls: SpawnConfig[] = [];
  constructor(private handler: (c: SpawnConfig, i: number) => Promise<SpawnResult> | SpawnResult) {}
  async spawnAndWait(config: SpawnConfig): Promise<SpawnResult> {
    const i = this.calls.length;
    this.calls.push(config);
    return this.handler(config, i);
  }
}

function ok(runId: string, output: unknown): SpawnResult {
  return { run_id: runId, status: 'success', output };
}

function createEngine(spawner: RunSpawner | undefined, events?: EngineEvents, maxDepth = 3): PipelineEngine {
  return new PipelineEngine(
    {
      configsDir: PROJECT_DIR,
      providerRegistry: { get: vi.fn(), register: vi.fn() } as any,
      db: new InMemoryRunStore(),
      ...(spawner ? { spawner } : {}),
      maxDepth,
    },
    events,
  );
}

/** A one-stage pipeline: fan out `child` over input.items. */
function mapPipeline(overrides: Record<string, unknown> = {}): PipelineDefinition {
  return {
    name: 'fanout-test',
    description: 'fan-out test',
    version: 1,
    stages: [
      {
        map: 'generate',
        over: 'input.items',
        pipeline: 'child',
        as: 'entity',
        ...overrides,
      } as any,
    ],
  };
}

describe('Fan-out (map) stage', () => {
  it('runs the sub-pipeline once per item and collects outputs in order', async () => {
    const spawner = new FakeSpawner((c, i) => ok(`run-${i}`, { page: (c.input as any).entity }));
    const engine = createEngine(spawner);

    const result = await engine.run({
      pipelineDef: mapPipeline(),
      input: { items: ['a', 'b', 'c'] },
    });

    expect(result.status).toBe('success');
    expect(spawner.calls).toHaveLength(3);
    // Each child got the item wrapped under `entity`
    expect(spawner.calls.map(c => (c.input as any).entity)).toEqual(['a', 'b', 'c']);
    // Every child is spawned as a child of this run at depth 1
    expect(spawner.calls.every(c => c.parentRunId === result.id && c.depth === 1)).toBe(true);

    const mapStage = result.stages[0];
    expect(mapStage.stage_name).toBe('generate');
    const out = mapStage.output as any;
    expect(out.total).toBe(3);
    expect(out.succeeded).toBe(3);
    expect(out.failed).toBe(0);
    expect(out.outputs).toEqual([{ page: 'a' }, { page: 'b' }, { page: 'c' }]);
    expect(out.results.map((r: any) => r.run_id)).toEqual(['run-0', 'run-1', 'run-2']);
  });

  it('bounds in-flight runs by concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const spawner = new FakeSpawner(async (c, i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 10));
      inFlight--;
      return ok(`run-${i}`, i);
    });
    const engine = createEngine(spawner);

    await engine.run({
      pipelineDef: mapPipeline({ concurrency: 2 }),
      input: { items: [1, 2, 3, 4, 5] },
    });

    expect(spawner.calls).toHaveLength(5);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBe(2);
  });

  it('fail-fast: stops launching after the first failure and fails the stage', async () => {
    const spawner = new FakeSpawner((_c, i) => {
      if (i === 0) throw new Error('boom');
      return ok(`run-${i}`, i);
    });
    const engine = createEngine(spawner);

    const result = await engine.run({
      pipelineDef: mapPipeline({ concurrency: 1, on_item_failure: 'fail-fast' }),
      input: { items: [1, 2, 3, 4] },
    });

    expect(result.status).toBe('failed');
    expect(result.stages[0].status).toBe('failed');
    // With concurrency 1 and fail-fast, the first failure blocks the rest
    expect(spawner.calls.length).toBeLessThan(4);
  });

  it('collect-all: runs every item, keeps successes, and lets the pipeline continue', async () => {
    const spawner = new FakeSpawner((_c, i) => {
      if (i === 1) throw new Error('item 1 failed');
      return ok(`run-${i}`, { n: i });
    });
    const events: string[] = [];
    const engine = createEngine(spawner, {
      onMapItemComplete: (e) => events.push(`${e.index}:${e.status}`),
    });

    const result = await engine.run({
      pipelineDef: mapPipeline({ concurrency: 3, on_item_failure: 'collect-all' }),
      input: { items: [0, 1, 2] },
    });

    expect(result.status).toBe('success');
    expect(spawner.calls).toHaveLength(3);
    const out = result.stages[0].output as any;
    expect(out.succeeded).toBe(2);
    expect(out.failed).toBe(1);
    expect(out.outputs).toEqual([{ n: 0 }, { n: 2 }]);
    const failedItem = out.results.find((r: any) => r.status === 'failed');
    expect(failedItem.error).toContain('item 1 failed');
    expect(events.sort()).toEqual(['0:success', '1:failed', '2:success']);
  });

  it('collect-all: fails only when every item fails', async () => {
    const spawner = new FakeSpawner(() => { throw new Error('nope'); });
    const engine = createEngine(spawner);

    const result = await engine.run({
      pipelineDef: mapPipeline({ on_item_failure: 'collect-all' }),
      input: { items: [1, 2] },
    });

    expect(result.status).toBe('failed');
  });

  it('propagates the collected output to a downstream map stage', async () => {
    const spawner = new FakeSpawner((c) => ok('r', { doubled: (c.input as any).value * 2 }));
    const engine = createEngine(spawner);

    const pipelineDef: PipelineDefinition = {
      name: 'chained-fanout',
      description: 'two map stages chained',
      version: 1,
      stages: [
        { map: 'first', over: 'input.items', pipeline: 'child', input: { value: '{{item}}' } } as any,
        { map: 'second', over: 'stages.first.output.outputs', pipeline: 'child', input: { value: '{{item.doubled}}' } } as any,
      ],
    };

    const result = await engine.run({ pipelineDef, input: { items: [1, 2] } });

    expect(result.status).toBe('success');
    // second stage maps over first stage's outputs: [{doubled:2},{doubled:4}]
    const secondInputs = spawner.calls.slice(2).map(c => (c.input as any).value);
    expect(secondInputs).toEqual([2, 4]);
    const secondOut = result.stages[1].output as any;
    expect(secondOut.outputs).toEqual([{ doubled: 4 }, { doubled: 8 }]);
  });

  it('empty list succeeds with an empty result set and spawns nothing', async () => {
    const spawner = new FakeSpawner(() => ok('r', 1));
    const engine = createEngine(spawner);

    const result = await engine.run({ pipelineDef: mapPipeline(), input: { items: [] } });

    expect(result.status).toBe('success');
    expect(spawner.calls).toHaveLength(0);
    expect((result.stages[0].output as any)).toMatchObject({ total: 0, succeeded: 0, failed: 0 });
  });

  it('fails the stage when `over` does not resolve to an array', async () => {
    const spawner = new FakeSpawner(() => ok('r', 1));
    const engine = createEngine(spawner);

    const result = await engine.run({
      pipelineDef: mapPipeline({ over: 'input.missing' }),
      input: { items: [1] },
    });

    expect(result.status).toBe('failed');
    const err = result.stages[0].tasks[0].agent_runs[0].error ?? '';
    expect(err).toContain('did not resolve to an array');
  });

  it('fails the stage when no spawner is configured', async () => {
    const engine = createEngine(undefined);

    const result = await engine.run({ pipelineDef: mapPipeline(), input: { items: [1] } });

    expect(result.status).toBe('failed');
    expect(result.stages[0].tasks[0].agent_runs[0].error).toContain('requires a run spawner');
  });

  it('enforces the depth limit before spawning', async () => {
    const spawner = new FakeSpawner(() => ok('r', 1));
    const engine = createEngine(spawner, undefined, 3);

    // depth 3 → children would be depth 4 > maxDepth 3
    const result = await engine.run({ pipelineDef: mapPipeline(), input: { items: [1] }, depth: 3 });

    expect(result.status).toBe('failed');
    expect(spawner.calls).toHaveLength(0);
    expect(result.stages[0].tasks[0].agent_runs[0].error).toContain('maxDepth');
  });

  it('skips the fan-out when its condition is not met', async () => {
    const spawner = new FakeSpawner(() => ok('r', 1));
    const engine = createEngine(spawner);

    const result = await engine.run({
      pipelineDef: mapPipeline({ condition: 'input.enabled == true' }),
      input: { items: [1, 2], enabled: false },
    });

    expect(result.status).toBe('success');
    expect(result.stages[0].status).toBe('skipped');
    expect(spawner.calls).toHaveLength(0);
  });

  it('emits map lifecycle events', async () => {
    const spawner = new FakeSpawner((_c, i) => ok(`r${i}`, i));
    const events: Array<{ type: string; data: any }> = [];
    const engine = createEngine(spawner, {
      onMapStart: (e) => events.push({ type: 'start', data: e }),
      onMapItemStart: (e) => events.push({ type: 'item_start', data: e }),
      onMapItemComplete: (e) => events.push({ type: 'item', data: e }),
      onMapComplete: (e) => events.push({ type: 'complete', data: e }),
    });

    await engine.run({ pipelineDef: mapPipeline(), input: { items: ['x', 'y'] } });

    expect(events.find(e => e.type === 'start')?.data).toMatchObject({ map_name: 'generate', total_items: 2 });
    expect(events.filter(e => e.type === 'item')).toHaveLength(2);
    expect(events.find(e => e.type === 'complete')?.data).toMatchObject({ succeeded: 2, failed: 0, status: 'success' });
  });

  it('names each item as it enters flight and when it settles (for --live progress)', async () => {
    const spawner = new FakeSpawner((_c, i) => {
      if (i === 1) throw new Error('boom');
      return ok(`run-${i}`, i);
    });
    const starts: Array<{ index: number; label: string }> = [];
    const completes: Array<{ index: number; label?: string; status: string; run_id?: string }> = [];
    const engine = createEngine(spawner, {
      onMapItemStart: (e) => starts.push({ index: e.index, label: e.label }),
      onMapItemComplete: (e) => completes.push({ index: e.index, label: e.label, status: e.status, run_id: e.run_id }),
    });

    // Objects with a `title` field → the label is the title, not the index.
    await engine.run({
      pipelineDef: mapPipeline({ concurrency: 3, on_item_failure: 'collect-all', as: 'entity' }),
      input: { items: [{ title: 'Alpha' }, { title: 'Beta' }, { title: 'Gamma' }] },
    });

    expect(starts.sort((a, b) => a.index - b.index)).toEqual([
      { index: 0, label: 'Alpha' },
      { index: 1, label: 'Beta' },
      { index: 2, label: 'Gamma' },
    ]);

    const byIndex = new Map(completes.map(c => [c.index, c]));
    expect(byIndex.get(0)).toMatchObject({ label: 'Alpha', status: 'success', run_id: 'run-0' });
    // The failing item carries its label at the moment it fails.
    expect(byIndex.get(1)).toMatchObject({ label: 'Beta', status: 'failed' });
    expect(byIndex.get(2)).toMatchObject({ label: 'Gamma', status: 'success', run_id: 'run-2' });
  });
});
