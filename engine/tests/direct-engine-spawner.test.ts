import { describe, it, expect, vi } from 'vitest';
import { DirectEngineSpawner } from '../src/spawners/direct-engine-spawner.js';
import type { EngineConfig } from '../src/engine.js';
import type { PipelineRun } from '@studio-foundation/contracts';

function makeSuccessRun(overrides?: Partial<PipelineRun>): PipelineRun {
  return {
    id: 'child-run-1',
    pipeline_name: 'test-pipe',
    status: 'success',
    started_at: new Date().toISOString(),
    stages: [
      {
        id: 's1',
        stage_name: 'final',
        status: 'success',
        started_at: new Date().toISOString(),
        tasks: [],
        output: { answer: 42 },
      },
    ],
    ...overrides,
  };
}

// We mock PipelineEngine to avoid real execution
vi.mock('../src/engine.js', () => ({
  PipelineEngine: vi.fn(function () {
    return { run: vi.fn() };
  }),
}));

describe('DirectEngineSpawner', () => {
  it('calls child engine.run() with correct args', async () => {
    const { PipelineEngine } = await import('../src/engine.js');
    const mockRun = vi.fn().mockResolvedValue(makeSuccessRun());
    (PipelineEngine as any).mockImplementation(function () { return { run: mockRun }; });

    const spawner = new DirectEngineSpawner({} as EngineConfig);
    await spawner.spawnAndWait({
      pipeline: 'recipe-developer',
      input: { dish: 'pasta' },
      parentRunId: 'parent-1',
      depth: 1,
    });

    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        pipeline: 'recipe-developer',
        input: { dish: 'pasta' },
        parentRunId: 'parent-1',
        depth: 1,
      })
    );
  });

  it('returns run_id, status, and last stage output on success', async () => {
    const { PipelineEngine } = await import('../src/engine.js');
    const successRun = makeSuccessRun();
    (PipelineEngine as any).mockImplementation(function () { return {
      run: vi.fn().mockResolvedValue(successRun),
    }; });

    const spawner = new DirectEngineSpawner({} as EngineConfig);
    const result = await spawner.spawnAndWait({
      pipeline: 'test',
      input: {},
      parentRunId: 'p1',
      depth: 1,
    });

    expect(result.run_id).toBe('child-run-1');
    expect(result.status).toBe('success');
    expect(result.output).toEqual({ answer: 42 });
  });

  it('throws when child run fails', async () => {
    const { PipelineEngine } = await import('../src/engine.js');
    const failedRun = makeSuccessRun({ id: 'child-fail', status: 'failed', stages: [] });
    (PipelineEngine as any).mockImplementation(function () { return {
      run: vi.fn().mockResolvedValue(failedRun),
    }; });

    const spawner = new DirectEngineSpawner({} as EngineConfig);
    await expect(
      spawner.spawnAndWait({ pipeline: 'bad', input: {}, parentRunId: 'p1', depth: 1 })
    ).rejects.toThrow('Child run child-fail failed');
  });

  it('throws when child run is rejected', async () => {
    const { PipelineEngine } = await import('../src/engine.js');
    const rejectedRun = makeSuccessRun({ id: 'child-rej', status: 'rejected', stages: [] });
    (PipelineEngine as any).mockImplementation(function () { return {
      run: vi.fn().mockResolvedValue(rejectedRun),
    }; });

    const spawner = new DirectEngineSpawner({} as EngineConfig);
    await expect(
      spawner.spawnAndWait({ pipeline: 'qa', input: {}, parentRunId: 'p1', depth: 1 })
    ).rejects.toThrow('Child run child-rej rejected');
  });

  it('surfaces the failed stage\'s real error instead of a bare status (STU-765)', async () => {
    const { PipelineEngine } = await import('../src/engine.js');
    const failedRun = makeSuccessRun({
      id: 'child-fail',
      status: 'failed',
      stages: [
        {
          id: 's1', stage_name: 'ok', status: 'success',
          started_at: new Date().toISOString(), tasks: [],
        },
        {
          id: 's2', stage_name: 'broken', status: 'failed',
          started_at: new Date().toISOString(),
          tasks: [{
            id: 't1', task_name: 'broken', status: 'failed',
            started_at: new Date().toISOString(),
            agent_runs: [{
              id: 'a1', agent_name: 'broken', attempt: 1, status: 'failed',
              tool_calls: 0, started_at: new Date().toISOString(),
              error: "400 json: cannot unmarshal object into Go struct field ChatCompletionRequest.model of type string",
            }],
          }],
        },
      ],
    });
    vi.mocked(PipelineEngine).mockImplementation(function () { return {
      run: vi.fn().mockResolvedValue(failedRun),
    }; });

    const spawner = new DirectEngineSpawner({} as EngineConfig);
    await expect(
      spawner.spawnAndWait({ pipeline: 'bad', input: {}, parentRunId: 'p1', depth: 1 })
    ).rejects.toThrow(
      'Child run child-fail failed: 400 json: cannot unmarshal object into Go struct field ChatCompletionRequest.model of type string'
    );
  });

  it('falls back to "no error recorded" when the failed stage carries none', async () => {
    const { PipelineEngine } = await import('../src/engine.js');
    const failedRun = makeSuccessRun({ id: 'child-fail-2', status: 'failed', stages: [] });
    vi.mocked(PipelineEngine).mockImplementation(function () { return {
      run: vi.fn().mockResolvedValue(failedRun),
    }; });

    const spawner = new DirectEngineSpawner({} as EngineConfig);
    await expect(
      spawner.spawnAndWait({ pipeline: 'bad', input: {}, parentRunId: 'p1', depth: 1 })
    ).rejects.toThrow('Child run child-fail-2 failed: no error recorded');
  });
});

describe('DirectEngineSpawner nesting (STU-615)', () => {
  it('hands itself down so a called pipeline can call/map in turn', async () => {
    const { PipelineEngine } = await import('../src/engine.js');
    const captured: any[] = [];
    (PipelineEngine as any).mockImplementation(function (cfg: any) {
      captured.push(cfg);
      return { run: vi.fn().mockResolvedValue(makeSuccessRun()) };
    });

    const spawner = new DirectEngineSpawner({ configsDir: '/x' } as unknown as EngineConfig);
    await spawner.spawnAndWait({ pipeline: 'child', input: {}, parentRunId: 'p1', depth: 1 });

    // The child engine's config must carry the spawner — without it, a call
    // stage at depth 2 dies with "requires a run spawner" while maxDepth
    // promises 3.
    expect(captured).toHaveLength(1);
    expect(captured[0].spawner).toBe(spawner);
    expect(captured[0].configsDir).toBe('/x');
  });
});

describe('DirectEngineSpawner — token usage roll-up (STU-750)', () => {
  it('sums the child run stages so the spawning stage can report what it cost', async () => {
    const { PipelineEngine } = await import('../src/engine.js');
    const run = makeSuccessRun({
      stages: [
        {
          id: 's1', stage_name: 'draft', status: 'success',
          started_at: new Date().toISOString(), tasks: [],
          token_usage: {
            prompt_tokens: 100, completion_tokens: 10, total_tokens: 160, cached_input_tokens: 50,
            by_model: { opus: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 160, cached_input_tokens: 50 } },
          },
        },
        {
          id: 's2', stage_name: 'review', status: 'success',
          started_at: new Date().toISOString(), tasks: [], output: { answer: 42 },
          token_usage: {
            prompt_tokens: 20, completion_tokens: 5, total_tokens: 25,
            by_model: { haiku: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
          },
        },
      ],
    });
    vi.mocked(PipelineEngine).mockImplementation(function () { return { run: vi.fn().mockResolvedValue(run) }; });

    const spawner = new DirectEngineSpawner({} as EngineConfig);
    const result = await spawner.spawnAndWait({ pipeline: 'test', input: {}, parentRunId: 'p1', depth: 1 });

    expect(result.token_usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 15,
      total_tokens: 185,
      cached_input_tokens: 50,
      by_model: {
        opus: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 160, cached_input_tokens: 50 },
        haiku: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
    });
  });

  it('omits token_usage when the child reported none', async () => {
    const { PipelineEngine } = await import('../src/engine.js');
    vi.mocked(PipelineEngine).mockImplementation(function () {
      return { run: vi.fn().mockResolvedValue(makeSuccessRun()) };
    });

    const spawner = new DirectEngineSpawner({} as EngineConfig);
    const result = await spawner.spawnAndWait({ pipeline: 'test', input: {}, parentRunId: 'p1', depth: 1 });

    expect(result.token_usage).toBeUndefined();
  });
});
