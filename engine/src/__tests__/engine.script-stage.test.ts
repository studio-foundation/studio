import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { PipelineEngine } from '../engine.js';
import type { PipelineDefinition } from '@studio/contracts';

// Mock runScript from runner to avoid real subprocess spawning
vi.mock('@studio/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@studio/runner')>();
  return {
    ...actual,
    runScript: vi.fn(),
  };
});

import { runScript } from '@studio/runner';

const FIXTURES_DIR = resolve(__dirname, '__fixtures__/script-stage');

const SCRIPT_PIPELINE: PipelineDefinition = {
  name: 'test-script-pipeline',
  description: 'Test pipeline with script stage',
  version: 1,
  stages: [
    {
      name: 'epub-ingestion',
      executor: 'script',
      script: 'scripts/parse.py',
      runtime: 'python',
      contract: 'book-context',
    },
  ],
};

function makeEngine() {
  return new PipelineEngine({
    configsDir: FIXTURES_DIR,
    providerRegistry: {} as any,
  });
}

describe('engine — script stage execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes a script stage and returns success when output matches contract', async () => {
    vi.mocked(runScript).mockResolvedValue({
      output: { title: 'My Book', chapters: 3 },
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 50,
    });

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: SCRIPT_PIPELINE,
      userInput: 'parse book.epub',
    });

    expect(result.status).toBe('success');
    expect(result.stages[0]?.status).toBe('success');
    expect(result.stages[0]?.output).toEqual({ title: 'My Book', chapters: 3 });
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runScript)).toHaveBeenCalledWith(
      expect.objectContaining({
        scriptPath: 'scripts/parse.py',
        runtime: 'python',
      }),
    );
  });

  it('retries on script error (runScript returns error field)', async () => {
    const scriptError = {
      output: null,
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 10,
      error: 'Script exited with code 1: parse error',
    };
    vi.mocked(runScript)
      .mockResolvedValueOnce(scriptError)
      .mockResolvedValueOnce(scriptError)
      .mockResolvedValue({
        output: { title: 'My Book', chapters: 3 },
        tool_calls: [],
        tool_calls_count: 0,
        duration_ms: 50,
      });

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: {
        ...SCRIPT_PIPELINE,
        stages: [{ ...SCRIPT_PIPELINE.stages[0], ralph: { max_attempts: 3, retry_strategy: 'none' } }],
      },
      userInput: 'parse book.epub',
    });

    expect(result.status).toBe('success');
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(3);
  });

  it('fails stage after exhausting max_attempts', async () => {
    vi.mocked(runScript).mockResolvedValue({
      output: null,
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 10,
      error: 'Script exited with code 1: always failing',
    });

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: {
        ...SCRIPT_PIPELINE,
        stages: [{ ...SCRIPT_PIPELINE.stages[0], ralph: { max_attempts: 2, retry_strategy: 'none' } }],
      },
      userInput: 'parse book.epub',
    });

    expect(result.status).toBe('failed');
    expect(result.stages[0]?.status).toBe('failed');
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(2);
  });
});
