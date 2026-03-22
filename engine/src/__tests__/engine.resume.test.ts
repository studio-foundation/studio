import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineEngine } from '../engine.js';
import type { PipelineDefinition } from '@studio/contracts';

vi.mock('@studio/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@studio/runner')>();
  return {
    ...actual,
    runScript: vi.fn(),
  };
});

import { runScript } from '@studio/runner';

function makeEngine() {
  return new PipelineEngine({
    configsDir: '/tmp',
    providerRegistry: {} as any,
  });
}

function mockScriptSuccess(output: Record<string, unknown> = { result: 'ok' }) {
  vi.mocked(runScript).mockResolvedValue({
    output,
    tool_calls: [],
    tool_calls_count: 0,
    duration_ms: 10,
  });
}

describe('engine — resume from stage', () => {
  beforeEach(() => vi.clearAllMocks());

  const pipeline: PipelineDefinition = {
    name: 'test-resume',
    description: 'test',
    version: 1,
    stages: [
      { name: 'stage-a', executor: 'script', script: 'x.py', runtime: 'shell' },
      { name: 'stage-b', executor: 'script', script: 'x.py', runtime: 'shell' },
      { name: 'stage-c', executor: 'script', script: 'x.py', runtime: 'shell' },
    ],
  };

  it('skips stages before resumeFromStage and marks them skipped', async () => {
    mockScriptSuccess({ result: 'c-result' });

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: pipeline,
      input: { x: 1 },
      resumeFromStage: 'stage-c',
      priorStageOutputs: new Map([
        ['stage-a', { result: 'a-cached' }],
        ['stage-b', { result: 'b-cached' }],
      ]),
      originalRunId: 'abc12345',
    });

    expect(result.status).toBe('success');
    expect(result.stages).toHaveLength(3);
    expect(result.stages[0]?.stage_name).toBe('stage-a');
    expect(result.stages[0]?.status).toBe('skipped');
    expect(result.stages[0]?.skipped_reason).toContain('abc12345');
    expect(result.stages[1]?.stage_name).toBe('stage-b');
    expect(result.stages[1]?.status).toBe('skipped');
    expect(result.stages[2]?.stage_name).toBe('stage-c');
    expect(result.stages[2]?.status).toBe('success');
    // Only stage-c was actually executed
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);
  });

  it('pre-populates context so resumed stage can access prior outputs', async () => {
    mockScriptSuccess({ result: 'ok' });

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: {
        ...pipeline,
        stages: [
          { name: 'stage-a', executor: 'script', script: 'x.py', runtime: 'shell' },
          { name: 'stage-b', executor: 'script', script: 'x.py', runtime: 'shell' },
        ],
      },
      input: { x: 1 },
      resumeFromStage: 'stage-b',
      priorStageOutputs: new Map([['stage-a', { result: 'a-cached' }]]),
    });

    // stage-b ran successfully (prior context was pre-populated, no crash)
    expect(result.status).toBe('success');
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0]?.status).toBe('skipped');
    expect(result.stages[1]?.status).toBe('success');
  });

  it('throws if resumeFromStage is not found in pipeline', async () => {
    const engine = makeEngine();
    await expect(
      engine.run({
        pipelineDef: pipeline,
        input: {},
        resumeFromStage: 'nonexistent-stage',
        priorStageOutputs: new Map(),
      })
    ).rejects.toThrow(/not found/i);
  });
});
