import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { PipelineEngine } from '../engine.js';
import type { PipelineDefinition } from '@studio-foundation/contracts';

vi.mock('@studio-foundation/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@studio-foundation/runner')>();
  return {
    ...actual,
    runScript: vi.fn(),
  };
});

import { runScript } from '@studio-foundation/runner';

const FIXTURES_DIR = resolve(__dirname, '__fixtures__/script-stage');

function makeEngine() {
  return new PipelineEngine({
    configsDir: FIXTURES_DIR,
    providerRegistry: {} as any,
  });
}

describe('engine — conditions inside sequential groups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips a conditional stage inside a sequential group', async () => {
    vi.mocked(runScript).mockResolvedValue({
      output: { done: true },
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 10,
    });

    const pipeline: PipelineDefinition = {
      name: 'test-group-conditions',
      description: 'test',
      version: 1,
      stages: [
        {
          group: 'processing',
          max_iterations: 1,
          stages: [
            {
              name: 'always-runs',
              executor: 'script',
              script: 'scripts/run.py',
              runtime: 'shell',
            },
            {
              name: 'conditional-in-group',
              executor: 'script',
              script: 'scripts/optional.py',
              runtime: 'shell',
              condition: 'input.optional >= 1',
            },
          ],
        },
      ],
    };

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: pipeline,
      input: { optional: 0 },
    });

    expect(result.status).toBe('success');
    expect(result.stages[0]?.status).toBe('success');
    expect(result.stages[1]?.status).toBe('skipped');
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);
  });

  it('marks group as skipped when all stages in sequential group are skipped', async () => {
    vi.mocked(runScript).mockResolvedValue({
      output: { done: true },
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 10,
    });

    // A stage after the group should still run
    const pipeline: PipelineDefinition = {
      name: 'test-all-skipped-group',
      description: 'test',
      version: 1,
      stages: [
        {
          group: 'optional-processing',
          max_iterations: 1,
          stages: [
            {
              name: 'optional-a',
              executor: 'script',
              script: 'scripts/a.py',
              runtime: 'shell',
              condition: 'input.run_optional >= 1',
            },
            {
              name: 'optional-b',
              executor: 'script',
              script: 'scripts/b.py',
              runtime: 'shell',
              condition: 'input.run_optional >= 1',
            },
          ],
        },
        {
          name: 'post-group-stage',
          executor: 'script',
          script: 'scripts/final.py',
          runtime: 'shell',
        },
      ],
    };

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: pipeline,
      input: { run_optional: 0 },
    });

    expect(result.status).toBe('success');
    // Both group stages skipped
    expect(result.stages[0]?.status).toBe('skipped');
    expect(result.stages[1]?.status).toBe('skipped');
    // Post-group stage ran
    expect(result.stages[2]?.status).toBe('success');
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);  // only post-group-stage
  });
});

describe('engine — conditions inside parallel groups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks parallel group as skipped when all stages are skipped', async () => {
    vi.mocked(runScript).mockResolvedValue({
      output: { done: true },
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 10,
    });

    const pipeline: PipelineDefinition = {
      name: 'test-parallel-all-skipped',
      description: 'test',
      version: 1,
      stages: [
        {
          group: 'optional-parallel',
          max_iterations: 1,
          mode: 'parallel',
          stages: [
            {
              name: 'parallel-a',
              executor: 'script',
              script: 'scripts/a.py',
              runtime: 'shell',
              condition: 'input.enabled >= 1',
            },
            {
              name: 'parallel-b',
              executor: 'script',
              script: 'scripts/b.py',
              runtime: 'shell',
              condition: 'input.enabled >= 1',
            },
          ],
        },
        {
          name: 'post-group',
          executor: 'script',
          script: 'scripts/final.py',
          runtime: 'shell',
        },
      ],
    };

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: pipeline,
      input: { enabled: 0 },
    });

    expect(result.status).toBe('success');
    expect(result.stages[0]?.status).toBe('skipped');
    expect(result.stages[1]?.status).toBe('skipped');
    expect(result.stages[2]?.status).toBe('success');
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);  // only post-group
  });

  it('runs parallel group normally when at least one stage is not skipped', async () => {
    vi.mocked(runScript).mockResolvedValue({
      output: { done: true },
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 10,
    });

    const pipeline: PipelineDefinition = {
      name: 'test-parallel-partial-skip',
      description: 'test',
      version: 1,
      stages: [
        {
          group: 'mixed-parallel',
          max_iterations: 1,
          mode: 'parallel',
          stages: [
            {
              name: 'always-runs',
              executor: 'script',
              script: 'scripts/a.py',
              runtime: 'shell',
            },
            {
              name: 'conditional',
              executor: 'script',
              script: 'scripts/b.py',
              runtime: 'shell',
              condition: 'input.enabled >= 1',
            },
          ],
        },
      ],
    };

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: pipeline,
      input: { enabled: 0 },
    });

    expect(result.status).toBe('success');
    expect(result.stages[0]?.status).toBe('success');
    expect(result.stages[1]?.status).toBe('skipped');
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);  // only always-runs
  });
});
