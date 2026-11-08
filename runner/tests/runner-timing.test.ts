import { describe, it, expect } from 'vitest';
import { runAgent } from '../src/runner.js';
import type { AgentLoopProvider, Provider } from '../src/providers/provider.js';
import type { LLMRequest, LLMResponse } from '@studio-foundation/contracts';
import { ProviderRegistry } from '../src/providers/registry.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const toolTurn = (name: string): LLMResponse => ({
  content: '',
  tool_calls: [{ id: `call-${name}`, name, arguments: {} }],
  finish_reason: 'tool_calls',
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});
const finalTurn: LLMResponse = {
  content: '"done"',
  tool_calls: [],
  finish_reason: 'stop',
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function toolRegistryWith(delays: Record<string, number>): ToolRegistry {
  const registry = new ToolRegistry();
  for (const [name, delay] of Object.entries(delays)) {
    registry.register({
      name,
      description: name,
      parameters: {},
      execute: async () => { await sleep(delay); return { success: true, output: 'ok' }; },
    });
  }
  return registry;
}

describe('runAgent timing (STU-2101)', () => {
  it('counts turns and splits model time from tool time', async () => {
    const script = [toolTurn('slow_a'), toolTurn('slow_b'), finalTurn];
    let i = 0;
    const provider: Provider = {
      name: 'mock',
      call: async (_req: LLMRequest) => { await sleep(15); return script[i++]; },
    };
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(provider);

    const result = await runAgent({
      agent: { name: 'a', provider: 'mock', model: 'm', tools: ['slow_a', 'slow_b'] },
      task: { description: 't' },
      context: {},
      toolRegistry: toolRegistryWith({ slow_a: 30, slow_b: 40 }),
      providerRegistry,
    });

    expect(result.llm_turns).toBe(3);
    expect(result.llm_ms).toBeGreaterThanOrEqual(40); // 3 x 15ms, timers may fire a hair early
    expect(result.tool_ms).toBeGreaterThanOrEqual(65); // 30 + 40
    expect(result.tool_ms).toBeLessThan(result.duration_ms);
  });

  it('measures tool time but leaves model time unset when the provider owns the loop', async () => {
    const loopProvider: AgentLoopProvider = {
      name: 'mock-loop',
      call: async () => { throw new Error('not used'); },
      runAgentLoop: async (_req, executeTool) => {
        const outcome = await executeTool('slow_a', {}, 'c1');
        return {
          content: '"done"',
          tool_calls: [{ id: 'c1', name: 'slow_a', arguments: {}, ...outcome }],
          finish_reason: 'stop',
        };
      },
    };
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(loopProvider);

    const result = await runAgent({
      agent: { name: 'a', provider: 'mock-loop', model: 'm', tools: ['slow_a'] },
      task: { description: 't' },
      context: {},
      toolRegistry: toolRegistryWith({ slow_a: 30 }),
      providerRegistry,
    });

    expect(result.tool_ms).toBeGreaterThanOrEqual(25);
    expect(result.llm_ms).toBeUndefined();
    expect(result.llm_turns).toBeUndefined();
  });

  it('takes the turn count from a provider that reports one', async () => {
    const loopProvider: AgentLoopProvider = {
      name: 'mock-loop',
      call: async () => { throw new Error('not used'); },
      runAgentLoop: async () => ({ content: '"done"', tool_calls: [], finish_reason: 'stop', turns: 4 }),
    };
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(loopProvider);

    const result = await runAgent({
      agent: { name: 'a', provider: 'mock-loop', model: 'm' },
      task: { description: 't' },
      context: {},
      toolRegistry: new ToolRegistry(),
      providerRegistry,
    });

    expect(result.llm_turns).toBe(4);
    expect(result.llm_ms).toBeUndefined();
  });
});
