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
import { ChildRunError } from '@studio-foundation/contracts';

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
    const completes: Array<{ index: number; label?: string; status: string; run_id?: string; output?: unknown }> = [];
    const engine = createEngine(spawner, {
      onMapItemStart: (e) => starts.push({ index: e.index, label: e.label }),
      onMapItemComplete: (e) => completes.push({ index: e.index, label: e.label, status: e.status, run_id: e.run_id, output: e.output }),
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
    // The completion event carries the child's output, so a consumer can render
    // what each item produced (STU-626), not just that it settled.
    expect(byIndex.get(0)).toMatchObject({ label: 'Alpha', status: 'success', run_id: 'run-0', output: 0 });
    // The failing item carries its label at the moment it fails.
    expect(byIndex.get(1)).toMatchObject({ label: 'Beta', status: 'failed' });
    expect(byIndex.get(2)).toMatchObject({ label: 'Gamma', status: 'success', run_id: 'run-2', output: 2 });
  });
});

describe('Fan-out (map) stage — token usage (STU-750)', () => {
  const usage = (model: string, total: number) => ({
    prompt_tokens: total, completion_tokens: 0, total_tokens: total,
    by_model: { [model]: { prompt_tokens: total, completion_tokens: 0, total_tokens: total } },
  });

  it('rolls each item child run up onto the map stage and the run total', async () => {
    const spawner = new FakeSpawner((c, i) => ({
      ...ok(`run-${i}`, { page: (c.input as { entity: string }).entity }),
      token_usage: usage('opus', 100 * (i + 1)),
    }));
    const events: EngineEvents = { onStageComplete: vi.fn(), onPipelineComplete: vi.fn(), onMapItemComplete: vi.fn() };
    const engine = createEngine(spawner, events);

    const result = await engine.run({ pipelineDef: mapPipeline(), input: { items: ['a', 'b', 'c'] } });

    // 100 + 200 + 300 — a map stage makes no LLM call of its own, so without the
    // roll-up the most expensive stage in a pipeline reports nothing.
    expect(result.stages[0].token_usage).toEqual({
      prompt_tokens: 600, completion_tokens: 0, total_tokens: 600,
      by_model: { opus: { prompt_tokens: 600, completion_tokens: 0, total_tokens: 600 } },
    });
    expect(events.onStageComplete).toHaveBeenCalledWith(
      expect.objectContaining({ token_usage: expect.objectContaining({ total_tokens: 600 }) }),
    );
    expect(events.onPipelineComplete).toHaveBeenCalledWith(
      expect.objectContaining({ total_tokens: 600, token_usage: expect.objectContaining({ total_tokens: 600 }) }),
    );
  });

  it('reports each item cost on its own map_item_complete event', async () => {
    const spawner = new FakeSpawner((c, i) => ({
      ...ok(`run-${i}`, { page: (c.input as { entity: string }).entity }),
      token_usage: usage('opus', 100 * (i + 1)),
    }));
    const onMapItemComplete = vi.fn();
    const engine = createEngine(spawner, { onMapItemComplete });

    await engine.run({ pipelineDef: mapPipeline(), input: { items: ['a', 'b'] } });

    expect(onMapItemComplete.mock.calls.map(([e]) => e.token_usage?.total_tokens)).toEqual([100, 200]);
  });

  it('leaves usage absent when no child reported any', async () => {
    const spawner = new FakeSpawner((c, i) => ok(`run-${i}`, { page: 'x' }));
    const engine = createEngine(spawner);

    const result = await engine.run({ pipelineDef: mapPipeline(), input: { items: ['a'] } });

    expect(result.stages[0].token_usage).toBeUndefined();
  });

  it('counts the items that ran even when a later one fails', async () => {
    const spawner = new FakeSpawner((c, i) => {
      if (i === 1) throw new Error('child blew up');
      return { ...ok(`run-${i}`, { page: 'x' }), token_usage: usage('opus', 100) };
    });
    const engine = createEngine(spawner);

    const result = await engine.run({
      pipelineDef: mapPipeline({ on_item_failure: 'collect-all', concurrency: 1 }),
      input: { items: ['a', 'b', 'c'] },
    });

    // Two items succeeded at 100 each. A plain throw carries no record of what
    // the child spent — only a ChildRunError does (see STU-1064 below).
    expect(result.stages[0].token_usage?.total_tokens).toBe(200);
  });
});

describe('Fan-out (map) stage — failed item breakdown (STU-1064)', () => {
  const usage = (total: number) => ({ prompt_tokens: total, completion_tokens: 0, total_tokens: total });

  const burned = (runId: string) => new ChildRunError(
    `Child run ${runId} failed: contract violation`,
    runId,
    'failed',
    [
      { stage: 'classify', status: 'success', attempts: 1, token_usage: usage(40) },
      { stage: 'generate-draft', status: 'failed', attempts: 3, token_usage: usage(300) },
    ],
    usage(340),
  );

  it('keeps a failed item cost on the item, the stage and the run total', async () => {
    const spawner = new FakeSpawner((c, i) => {
      if (i === 1) throw burned('run-1');
      return { ...ok(`run-${i}`, { page: 'x' }), token_usage: usage(100) };
    });
    const engine = createEngine(spawner);

    const result = await engine.run({
      pipelineDef: mapPipeline({ on_item_failure: 'collect-all', concurrency: 1 }),
      input: { items: ['a', 'b', 'c'] },
    });

    const output = result.stages[0].output as { results: Array<Record<string, unknown>> };
    expect(output.results[1]).toMatchObject({
      status: 'failed',
      run_id: 'run-1',
      token_usage: usage(340),
      stages: [
        { stage: 'classify', status: 'success', attempts: 1, token_usage: usage(40) },
        { stage: 'generate-draft', status: 'failed', attempts: 3, token_usage: usage(300) },
      ],
    });
    // 100 + 100 succeeded, 340 burned by the failure. Dropping the last term is
    // what made a failed item price as a single unpriced call.
    expect(result.stages[0].token_usage?.total_tokens).toBe(540);
  });

  it('emits the failed item breakdown on its map_item_complete event', async () => {
    const spawner = new FakeSpawner(() => { throw burned('run-0'); });
    const onMapItemComplete = vi.fn();
    const engine = createEngine(spawner, { onMapItemComplete });

    await engine.run({
      pipelineDef: mapPipeline({ on_item_failure: 'collect-all' }),
      input: { items: ['a'] },
    });

    expect(onMapItemComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        run_id: 'run-0',
        token_usage: usage(340),
        stages: expect.arrayContaining([
          expect.objectContaining({ stage: 'generate-draft', attempts: 3 }),
        ]),
      }),
    );
  });

  it('passes the successful item breakdown through untouched', async () => {
    const spawner = new FakeSpawner((c, i) => ({
      ...ok(`run-${i}`, { page: 'x' }),
      token_usage: usage(100),
      stages: [{ stage: 'draft', status: 'success' as const, attempts: 2, token_usage: usage(100) }],
    }));
    const engine = createEngine(spawner);

    const result = await engine.run({ pipelineDef: mapPipeline(), input: { items: ['a'] } });

    const output = result.stages[0].output as { results: Array<Record<string, unknown>> };
    expect(output.results[0]).toMatchObject({
      status: 'success',
      token_usage: usage(100),
      stages: [{ stage: 'draft', status: 'success', attempts: 2, token_usage: usage(100) }],
    });
  });
});
