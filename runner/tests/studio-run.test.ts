import { describe, it, expect, vi } from 'vitest';
import { createStudioRunTool } from '../src/tools/builtin/studio-run.js';
import type { RunSpawner } from '@studio-foundation/contracts';

function makeSpawner(overrides?: Partial<RunSpawner>): RunSpawner {
  return {
    spawnAndWait: vi.fn().mockResolvedValue({
      run_id: 'child-abc',
      status: 'success',
      output: { result: 'done' },
    }),
    ...overrides,
  };
}

describe('createStudioRunTool', () => {
  it('returns a tool named studio_run-run_pipeline', () => {
    const tools = createStudioRunTool({
      spawner: makeSpawner(),
      currentRunId: 'parent-1',
      currentDepth: 0,
      maxDepth: 3,
    });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('studio_run-run_pipeline');
  });

  it('throws depth limit error before calling spawner', async () => {
    const spawner = makeSpawner();
    const tools = createStudioRunTool({
      spawner,
      currentRunId: 'parent-1',
      currentDepth: 3,  // already at max
      maxDepth: 3,
    });
    const tool = tools[0];
    await expect(
      tool.execute({ pipeline: 'my-pipe', input: { x: 1 }, wait: true })
    ).rejects.toThrow('studio-run depth limit reached (max: 3)');
    expect(spawner.spawnAndWait).not.toHaveBeenCalled();
  });

  it('calls spawner with correct config and returns result', async () => {
    const spawner = makeSpawner();
    const tools = createStudioRunTool({
      spawner,
      currentRunId: 'parent-1',
      currentDepth: 0,
      maxDepth: 3,
    });
    const result = await tools[0].execute({
      pipeline: 'recipe-developer',
      input: { dish: 'pasta' },
      wait: true,
    });
    expect(spawner.spawnAndWait).toHaveBeenCalledWith({
      pipeline: 'recipe-developer',
      input: { dish: 'pasta' },
      parentRunId: 'parent-1',
      depth: 1,
    });
    expect(result).toEqual({
      success: true,
      output: { run_id: 'child-abc', status: 'success', output: { result: 'done' } },
    });
  });

  it('propagates error when spawner throws', async () => {
    const spawner = makeSpawner({
      spawnAndWait: vi.fn().mockRejectedValue(new Error('Child run child-abc failed: contract violation')),
    });
    const tools = createStudioRunTool({
      spawner,
      currentRunId: 'parent-1',
      currentDepth: 0,
      maxDepth: 3,
    });
    await expect(
      tools[0].execute({ pipeline: 'bad-pipe', input: {}, wait: true })
    ).rejects.toThrow('Child run child-abc failed');
  });

  it('throws when wait is false (not supported in v1)', async () => {
    const tools = createStudioRunTool({
      spawner: makeSpawner(),
      currentRunId: 'parent-1',
      currentDepth: 0,
      maxDepth: 3,
    });
    await expect(
      tools[0].execute({ pipeline: 'x', input: {}, wait: false })
    ).rejects.toThrow('wait: false is not supported');
  });
});
