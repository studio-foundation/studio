// STU-1672 — a `compact:` block with a threshold but no `summarizer` used to
// silently disable compaction: `compactAgentConfig` stayed null and the stage's
// context kept growing until the provider's own limit rejected the call. The
// loader must fail loudly instead, the same way it already does for an agent
// stage missing a provider or model (stage-executor.ts).

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import type { LLMRequest, LLMResponse, PipelineDefinition } from '@studio-foundation/contracts';
import { ProviderRegistry, ToolRegistry } from '@studio-foundation/runner';
import { PipelineEngine } from '../engine.js';

const FIXTURES_DIR = resolve(__dirname, '__fixtures__/compact-config');

class FakeProvider {
  readonly name = 'fake';
  readonly calls: LLMRequest[] = [];

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.calls.push(request);
    return {
      content: '{}',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
}

function makeEngine() {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new FakeProvider() as never);
  return new PipelineEngine({
    configsDir: FIXTURES_DIR,
    providerRegistry,
    toolRegistry: new ToolRegistry(),
  });
}

function pipelineWith(agent: string): PipelineDefinition {
  return {
    name: 'compact-config-pipeline',
    description: 'test',
    version: 1,
    stages: [{ name: 'main', agent }],
  };
}

describe('engine — compact config validation (STU-1672)', () => {
  it('fails loudly when compact.threshold_tokens is set with no compact.summarizer', async () => {
    const engine = makeEngine();

    await expect(
      engine.run({ pipelineDef: pipelineWith('no-summarizer'), userInput: 'go' }),
    ).rejects.toThrow(/compact\.summarizer/);
  });

  it('names the offending stage and agent in the error', async () => {
    const engine = makeEngine();

    await expect(
      engine.run({ pipelineDef: pipelineWith('no-summarizer'), userInput: 'go' }),
    ).rejects.toThrow(/'no-summarizer'.*'main'/s);
  });

  it('still loads and runs when compact.summarizer is present', async () => {
    const engine = makeEngine();

    const result = await engine.run({ pipelineDef: pipelineWith('with-summarizer'), userInput: 'go' });

    expect(result.status).toBe('success');
  });
});
