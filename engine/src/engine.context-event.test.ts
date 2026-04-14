import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PipelineEngine } from './engine.js';
import { createDefaultRegistry, ToolRegistry, MockProvider } from '@studio-foundation/runner';
import type { StageContextEvent } from './events.js';

async function makeTestDirs(): Promise<{ configsDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'studio-ctx-test-'));
  const configsDir = join(base, '.studio');
  await mkdir(join(configsDir, 'pipelines'), { recursive: true });
  await mkdir(join(configsDir, 'agents'), { recursive: true });
  await mkdir(join(configsDir, 'contracts'), { recursive: true });

  await writeFile(
    join(configsDir, 'pipelines', 'test-pipe.pipeline.yaml'),
    `
name: test-pipe
description: test
version: 1
stages:
  - name: my-stage
    kind: analysis
    agent: analyst
    contract: stage-contract
    context:
      include: [input]
`
  );

  await writeFile(
    join(configsDir, 'agents', 'analyst.agent.yaml'),
    `
name: analyst
provider: mock
model: mock
system_prompt: "You are an analyst."
`
  );

  await writeFile(
    join(configsDir, 'contracts', 'stage-contract.contract.yaml'),
    `
name: stage-contract
version: 1
schema:
  required_fields:
    - summary
`
  );

  return { configsDir };
}

// MockProvider keys on contract_name (= stage_contract). Use this in all tests.
const MOCK_STAGE_KEY = 'stage-contract';

describe('PipelineEngine — onStageContext event', () => {
  it('emits onStageContext once per stage', async () => {
    const { configsDir } = await makeTestDirs();

    const mockStages = new Map([
      [MOCK_STAGE_KEY, { output: { summary: 'done' }, tool_calls: [] }],
    ]);
    const mockProvider = new MockProvider(mockStages);
    const providerRegistry = createDefaultRegistry({});
    providerRegistry.register(mockProvider);
    const toolRegistry = new ToolRegistry();

    const received: StageContextEvent[] = [];

    const engine = new PipelineEngine(
      { configsDir, providerRegistry, toolRegistry },
      { onStageContext: (e) => received.push(e) }
    );

    await engine.run({ pipeline: 'test-pipe', input: 'test input' });

    expect(received).toHaveLength(1);
    expect(received[0].stage).toBe('my-stage');
    expect(received[0].run_id).toMatch(/^[0-9a-f-]{36}$/); // uuid
    expect(received[0].context_keys.input).toBe('test input'.length);
  });

  it('includes no context_content by default (DEBUG unset)', async () => {
    const { configsDir } = await makeTestDirs();
    delete process.env.DEBUG;

    const mockProvider = new MockProvider(
      new Map([[MOCK_STAGE_KEY, { output: { summary: 'done' }, tool_calls: [] }]])
    );
    const providerRegistry = createDefaultRegistry({});
    providerRegistry.register(mockProvider);

    const received: StageContextEvent[] = [];
    const engine = new PipelineEngine(
      { configsDir, providerRegistry, toolRegistry: new ToolRegistry() },
      { onStageContext: (e) => received.push(e) }
    );

    await engine.run({ pipeline: 'test-pipe', input: 'hello' });

    expect(received[0].context_content).toBeUndefined();
    expect(received[0].system_prompt).toBeUndefined();
  });

  it('includes context_content when DEBUG=studio:context', async () => {
    const { configsDir } = await makeTestDirs();
    process.env.DEBUG = 'studio:context';

    const mockProvider = new MockProvider(
      new Map([[MOCK_STAGE_KEY, { output: { summary: 'done' }, tool_calls: [] }]])
    );
    const providerRegistry = createDefaultRegistry({});
    providerRegistry.register(mockProvider);

    const received: StageContextEvent[] = [];
    const engine = new PipelineEngine(
      { configsDir, providerRegistry, toolRegistry: new ToolRegistry() },
      { onStageContext: (e) => received.push(e) }
    );

    await engine.run({ pipeline: 'test-pipe', input: 'hello' });

    expect(received[0].context_content).toBeDefined();
    expect(received[0].context_content?.input).toBe('hello');
    expect(received[0].system_prompt).toBeUndefined();

    delete process.env.DEBUG;
  });

  it('includes system_prompt when DEBUG=studio:context:verbose', async () => {
    const { configsDir } = await makeTestDirs();
    process.env.DEBUG = 'studio:context:verbose';

    const mockProvider = new MockProvider(
      new Map([[MOCK_STAGE_KEY, { output: { summary: 'done' }, tool_calls: [] }]])
    );
    const providerRegistry = createDefaultRegistry({});
    providerRegistry.register(mockProvider);

    const received: StageContextEvent[] = [];
    const engine = new PipelineEngine(
      { configsDir, providerRegistry, toolRegistry: new ToolRegistry() },
      { onStageContext: (e) => received.push(e) }
    );

    await engine.run({ pipeline: 'test-pipe', input: 'hello' });

    expect(received[0].context_content).toBeDefined(); // verbose implies context
    expect(received[0].system_prompt).toBe('You are an analyst.');

    delete process.env.DEBUG;
  });

  it('does not call handler at all when onStageContext is not registered', async () => {
    const { configsDir } = await makeTestDirs();

    const mockProvider = new MockProvider(
      new Map([[MOCK_STAGE_KEY, { output: { summary: 'done' }, tool_calls: [] }]])
    );
    const providerRegistry = createDefaultRegistry({});
    providerRegistry.register(mockProvider);

    // No onStageContext handler
    const engine = new PipelineEngine(
      { configsDir, providerRegistry, toolRegistry: new ToolRegistry() },
      { onStageComplete: vi.fn() } // some other handler but not onStageContext
    );

    // Should not throw
    await engine.run({ pipeline: 'test-pipe', input: 'hello' });
  });
});
