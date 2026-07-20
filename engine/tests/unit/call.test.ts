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

const PROJECT_DIR = '/tmp/call-nonexistent'; // pipelineDef is used, so no files are read

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

/** A one-stage pipeline: call `child` once. */
function callPipeline(overrides: Record<string, unknown> = {}): PipelineDefinition {
  return {
    name: 'call-test',
    description: 'one-shot call test',
    version: 1,
    stages: [
      {
        call: 'run-child',
        pipeline: 'child',
        ...overrides,
      } as any,
    ],
  };
}

describe('Call (one-shot sub-pipeline) stage', () => {
  it('runs the sub-pipeline once and exposes its output under the stage name', async () => {
    const spawner = new FakeSpawner(() => ok('run-0', { pages: 3 }));
    const engine = createEngine(spawner);

    const result = await engine.run({
      pipelineDef: callPipeline({ input: { book: '{{input.book}}' } }),
      input: { book: 'Dune' },
    });

    expect(result.status).toBe('success');
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0].pipeline).toBe('child');
    expect((spawner.calls[0].input as any).book).toBe('Dune');
    // Spawned as a child of this run at depth 1
    expect(spawner.calls[0].parentRunId).toBe(result.id);
    expect(spawner.calls[0].depth).toBe(1);

    const stage = result.stages[0];
    expect(stage.stage_name).toBe('run-child');
    expect(stage.status).toBe('success');
    // Output is the child's output, propagated directly (not wrapped).
    expect((stage as any).output).toEqual({ pages: 3 });
  });

  it('defaults the child pipeline to the stage name', async () => {
    const spawner = new FakeSpawner(() => ok('r', 1));
    const engine = createEngine(spawner);

    const pipelineDef: PipelineDefinition = {
      name: 'default-pipeline', description: 'd', version: 1,
      stages: [{ call: 'wiki-extraction' } as any],
    };
    const result = await engine.run({ pipelineDef, input: { book: 'X' } });

    expect(result.status).toBe('success');
    expect(spawner.calls[0].pipeline).toBe('wiki-extraction');
  });

  it('forwards the parent input verbatim when no template is given', async () => {
    const spawner = new FakeSpawner(() => ok('r', 1));
    const engine = createEngine(spawner);

    await engine.run({ pipelineDef: callPipeline(), input: { book: 'X', chapters: 5 } });

    expect(spawner.calls[0].input).toEqual({ book: 'X', chapters: 5 });
  });

  it('chains calls: a later call reads an earlier call\'s output', async () => {
    const spawner = new FakeSpawner((c, i) => {
      if (i === 0) return ok('r0', { count: 10 });
      return ok('r1', { doubled: (c.input as any).n * 2 });
    });
    const engine = createEngine(spawner);

    const pipelineDef: PipelineDefinition = {
      name: 'chained-calls', description: 'two calls chained', version: 1,
      stages: [
        { call: 'first', pipeline: 'child' } as any,
        { call: 'second', pipeline: 'child', input: { n: '{{stages.first.output.count}}' } } as any,
      ],
    };

    const result = await engine.run({ pipelineDef, input: {} });

    expect(result.status).toBe('success');
    expect((spawner.calls[1].input as any).n).toBe(10);
    expect((result.stages[1] as any).output).toEqual({ doubled: 20 });
  });

  it('propagates a child failure to the parent stage and stops the pipeline', async () => {
    const spawner = new FakeSpawner(() => { throw new Error('child boom'); });
    const engine = createEngine(spawner);

    const pipelineDef: PipelineDefinition = {
      name: 'fail-chain', description: 'd', version: 1,
      stages: [
        { call: 'a', pipeline: 'child' } as any,
        { call: 'b', pipeline: 'child' } as any,
      ],
    };
    const result = await engine.run({ pipelineDef, input: {} });

    expect(result.status).toBe('failed');
    expect(result.stages).toHaveLength(1); // second call never ran
    expect(result.stages[0].status).toBe('failed');
    expect(result.stages[0].tasks[0].agent_runs[0].error).toContain('child boom');
  });

  it('skips the call when its condition is not met', async () => {
    const spawner = new FakeSpawner(() => ok('r', 1));
    const engine = createEngine(spawner);

    const result = await engine.run({
      pipelineDef: callPipeline({ condition: 'input.enabled == true' }),
      input: { enabled: false },
    });

    expect(result.status).toBe('success');
    expect(result.stages[0].status).toBe('skipped');
    expect(spawner.calls).toHaveLength(0);
  });

  it('fails the stage when no spawner is configured', async () => {
    const engine = createEngine(undefined);

    const result = await engine.run({ pipelineDef: callPipeline(), input: {} });

    expect(result.status).toBe('failed');
    expect(result.stages[0].tasks[0].agent_runs[0].error).toContain('requires a run spawner');
  });

  it('enforces the depth limit before spawning', async () => {
    const spawner = new FakeSpawner(() => ok('r', 1));
    const engine = createEngine(spawner, undefined, 3);

    // depth 3 → child would be depth 4 > maxDepth 3
    const result = await engine.run({ pipelineDef: callPipeline(), input: {}, depth: 3 });

    expect(result.status).toBe('failed');
    expect(spawner.calls).toHaveLength(0);
    expect(result.stages[0].tasks[0].agent_runs[0].error).toContain('maxDepth');
  });

  it('fails when the parent input cannot be forwarded and no template is given', async () => {
    const spawner = new FakeSpawner(() => ok('r', 1));
    const engine = createEngine(spawner);

    // string input, no `input:` template → cannot forward as a structured child input
    const result = await engine.run({ pipelineDef: callPipeline(), input: 'just-a-string' });

    expect(result.status).toBe('failed');
    expect(spawner.calls).toHaveLength(0);
    expect(result.stages[0].tasks[0].agent_runs[0].error).toContain('not an object');
  });

  it('restart: skips a call stage before the resume point and re-runs from it', async () => {
    const spawner = new FakeSpawner((c) => ok('r', { seen: (c.input as any).n }));
    const engine = createEngine(spawner);

    const pipelineDef: PipelineDefinition = {
      name: 'restartable', description: 'd', version: 1,
      stages: [
        { call: 'wiki-extraction', pipeline: 'child' } as any,
        { call: 'wiki-resolution', pipeline: 'child', input: { n: '{{stages.wiki-extraction.output.count}}' } } as any,
      ],
    };

    const result = await engine.run({
      pipelineDef,
      input: {},
      resumeFromStage: 'wiki-resolution',
      priorStageOutputs: new Map([['wiki-extraction', { count: 42 }]]),
      originalRunId: 'orig-run',
    });

    expect(result.status).toBe('success');
    // Only the resumed stage spawned; extraction was skipped and replayed.
    expect(spawner.calls).toHaveLength(1);
    expect((spawner.calls[0].input as any).n).toBe(42);
    expect(result.stages[0].status).toBe('skipped');
    expect(result.stages[1].status).toBe('success');
  });

  it('emits stage lifecycle events', async () => {
    const spawner = new FakeSpawner(() => ok('r', { ok: true }));
    const events: Array<{ type: string; name: string; status?: string }> = [];
    const engine = createEngine(spawner, {
      onStageStart: (e) => events.push({ type: 'start', name: e.stage_name }),
      onStageComplete: (e) => events.push({ type: 'complete', name: e.stage_name, status: e.status }),
    });

    await engine.run({ pipelineDef: callPipeline(), input: { book: 'X' } });

    expect(events).toContainEqual({ type: 'start', name: 'run-child' });
    expect(events).toContainEqual({ type: 'complete', name: 'run-child', status: 'success' });
  });
});
