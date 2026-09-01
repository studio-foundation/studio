import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { PipelineEngine, type EngineConfig } from '../engine.js';
import { DirectEngineSpawner } from '../spawners/direct-engine-spawner.js';
import type { PipelineDefinition } from '@studio-foundation/contracts';

// Mock runScript from runner to avoid real subprocess spawning
vi.mock('@studio-foundation/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@studio-foundation/runner')>();
  return {
    ...actual,
    runScript: vi.fn(),
  };
});

import { ProviderRegistry, ToolRegistry, runScript } from '@studio-foundation/runner';

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

  it('does not retry a script error — a deterministic crash fails fast (STU-568)', async () => {
    // A script is deterministic: re-running the same command on the same stdin
    // yields the same crash. Burning 3 attempts on an identical ImportError is
    // exactly what STU-568 fixes — even with max_attempts: 3, one call is enough.
    vi.mocked(runScript).mockResolvedValue({
      output: null,
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 10,
      error: "Script exited with code 1: ImportError: cannot import name 'EXTRACTION_CONFIG_FILE'",
    });

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: {
        ...SCRIPT_PIPELINE,
        stages: [{ ...SCRIPT_PIPELINE.stages[0], ralph: { max_attempts: 3, retry_strategy: 'none' } }],
      },
      userInput: 'parse book.epub',
    });

    expect(result.status).toBe('failed');
    expect(result.stages[0]?.status).toBe('failed');
    // Failed on the first attempt without burning the other two.
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);

    // The child's real reason (exit code + stderr) is surfaced on the agent run
    // — this is what `studio status` and the CLI's "Errors:" line read (STU-568).
    const lastAgentRun = result.stages[0]?.tasks[0]?.agent_runs.at(-1);
    expect(lastAgentRun?.status).toBe('failed');
    expect(lastAgentRun?.error).toMatch(/ImportError: cannot import name 'EXTRACTION_CONFIG_FILE'/);
  });

  // A fan-out over data is the natural shape for a script sub-pipeline, and the
  // one that pays for a flattened input: `buildItemInput` assembles the item
  // structurally, so the child's script must receive it that way. (STU-1196)
  it('hands a map child its item as an object, not a YAML dump', async () => {
    vi.mocked(runScript).mockResolvedValue({
      output: { title: 'ok' },
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 5,
    });

    const engineConfig: EngineConfig = {
      configsDir: FIXTURES_DIR,
      providerRegistry: new ProviderRegistry(),
      toolRegistry: new ToolRegistry(),
    };
    const engine = new PipelineEngine({
      ...engineConfig,
      spawner: new DirectEngineSpawner(engineConfig),
      maxDepth: 3,
    });

    const result = await engine.run({
      pipelineDef: {
        name: 'fan-out',
        description: 'test',
        version: 1,
        stages: [
          {
            map: 'items',
            over: 'input.feeds',
            pipeline: 'per-item',
            input: { source: '{{item.name}}', url: '{{item.url}}' },
          } as never,
        ],
      },
      userInput: { feeds: [{ name: 'Example Feed', url: 'https://example.com/feed' }] },
    });

    expect(result.status).toBe('success');
    expect(vi.mocked(runScript)).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          input: { source: 'Example Feed', url: 'https://example.com/feed' },
        }),
      }),
    );
  });
});
