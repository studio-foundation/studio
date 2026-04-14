import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { PipelineEngine } from '../engine.js';
import type { PipelineDefinition } from '@studio-foundation/contracts';

// Mock the runner so we can inspect which stages actually ran
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

function mockScriptSuccess(output: Record<string, unknown> = { result: 'ok' }) {
  vi.mocked(runScript).mockResolvedValue({
    output,
    tool_calls: [],
    tool_calls_count: 0,
    duration_ms: 10,
  });
}

describe('engine — stage conditions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips a stage when input condition is false', async () => {
    mockScriptSuccess();

    const pipeline: PipelineDefinition = {
      name: 'test-conditions',
      description: 'test',
      version: 1,
      stages: [
        {
          name: 'always-runs',
          executor: 'script',
          script: 'scripts/parse.py',
          runtime: 'shell',
        },
        {
          name: 'conditional-stage',
          executor: 'script',
          script: 'scripts/parse.py',
          runtime: 'shell',
          condition: 'input.meals_count >= 6',
        },
      ],
    };

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: pipeline,
      input: { meals_count: 3 },  // condition is false — stage should skip
    });

    expect(result.status).toBe('success');
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0]?.status).toBe('success');
    expect(result.stages[1]?.status).toBe('skipped');
    // Script was only called once (for always-runs, not conditional-stage)
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);
  });

  it('runs a stage when input condition is true', async () => {
    mockScriptSuccess();

    const pipeline: PipelineDefinition = {
      name: 'test-conditions-true',
      description: 'test',
      version: 1,
      stages: [
        {
          name: 'conditional-stage',
          executor: 'script',
          script: 'scripts/parse.py',
          runtime: 'shell',
          condition: 'input.meals_count >= 6',
        },
      ],
    };

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: pipeline,
      input: { meals_count: 7 },  // condition is true — stage should run
    });

    expect(result.status).toBe('success');
    expect(result.stages[0]?.status).toBe('success');
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);
  });

  it('skips a stage based on previous stage output', async () => {
    // First call returns extraction result, second call would be entity-resolution
    vi.mocked(runScript).mockResolvedValueOnce({
      output: { counts: { OTHER: 0, PERSON: 2 } },
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 10,
    });

    const pipeline: PipelineDefinition = {
      name: 'test-conditions-stage-output',
      description: 'test',
      version: 1,
      stages: [
        {
          name: 'entity-extraction',
          executor: 'script',
          script: 'scripts/extract.py',
          runtime: 'shell',
          context: { include: ['input'] },
        },
        {
          name: 'entity-resolution-OTHER',
          executor: 'script',
          script: 'scripts/resolve.py',
          runtime: 'shell',
          condition: 'stages.entity-extraction.output.counts.OTHER > 0',
          context: { include: ['all_stage_outputs'] },
        },
      ],
    };

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: pipeline,
      input: 'extract entities',
    });

    expect(result.status).toBe('success');
    expect(result.stages[0]?.status).toBe('success');
    expect(result.stages[1]?.status).toBe('skipped');  // counts.OTHER is 0
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);  // only extraction ran
  });

  it('pipeline continues after skipped stage', async () => {
    mockScriptSuccess({ final: 'result' });

    const pipeline: PipelineDefinition = {
      name: 'test-skip-continues',
      description: 'test',
      version: 1,
      stages: [
        {
          name: 'skipped-stage',
          executor: 'script',
          script: 'scripts/parse.py',
          runtime: 'shell',
          condition: 'input.run_optional >= 1',
        },
        {
          name: 'final-stage',
          executor: 'script',
          script: 'scripts/finalize.py',
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
    expect(result.stages[0]?.status).toBe('skipped');
    expect(result.stages[1]?.status).toBe('success');
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);  // only final-stage
  });
});
