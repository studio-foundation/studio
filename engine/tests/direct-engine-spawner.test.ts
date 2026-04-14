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
});
