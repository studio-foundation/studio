/**
 * Runner tests with mock provider
 */

import { describe, it, expect } from 'vitest';
import { runAgent } from '../src/runner.js';
import type { Provider } from '../src/providers/provider.js';
import type { LLMRequest, LLMResponse } from '@studio/contracts';
import { ProviderRegistry } from '../src/providers/registry.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';

// Mock provider for testing
class MockProvider implements Provider {
  readonly name = 'mock';
  private responses: LLMResponse[];
  private currentIndex = 0;

  constructor(responses: LLMResponse[]) {
    this.responses = responses;
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    if (this.currentIndex >= this.responses.length) {
      throw new Error('Mock provider ran out of responses');
    }
    return this.responses[this.currentIndex++];
  }
}

// Provider that always returns a tool call (infinite loop simulation)
class InfiniteToolCallProvider implements Provider {
  readonly name = 'mock';

  async call(_request: LLMRequest): Promise<LLMResponse> {
    return {
      content: '',
      tool_calls: [{ id: 'call-1', name: 'infinite_tool', arguments: {} }],
      finish_reason: 'tool_calls',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  }
}

describe('runAgent', () => {
  it('should run a simple agent task without tools', async () => {
    // Setup mock provider with a simple response
    const mockProvider = new MockProvider([
      {
        content: '{"result": "Hello World"}',
        tool_calls: [],
        finish_reason: 'stop',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        }
      }
    ]);

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);

    const toolRegistry = new ToolRegistry();

    const result = await runAgent({
      agent: {
        name: 'test-agent',
        provider: 'mock',
        model: 'test-model'
      },
      task: {
        description: 'Say hello'
      },
      context: {},
      toolRegistry,
      providerRegistry
    });

    expect(result.output).toEqual({ result: 'Hello World' });
    expect(result.tool_calls_count).toBe(0);
    expect(result.tool_calls).toEqual([]);
  });

  it('should execute tools in multi-turn conversation', async () => {
    // Setup a tool
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: {},
      execute: async ({ city }) => ({
        success: true,
        output: { city, temperature: 20, condition: 'sunny' }
      })
    });

    // Setup mock provider with tool call then final response
    const mockProvider = new MockProvider([
      // First response: make a tool call
      {
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            name: 'get_weather',
            arguments: { city: 'Paris' }
          }
        ],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      },
      // Second response: final answer
      {
        content: '{"result": "The weather in Paris is sunny, 20 degrees"}',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
      }
    ]);

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);

    const result = await runAgent({
      agent: {
        name: 'test-agent',
        provider: 'mock',
        model: 'test-model'
      },
      task: {
        description: 'Get weather for Paris'
      },
      context: {},
      toolRegistry,
      providerRegistry
    });

    expect(result.tool_calls_count).toBe(1);
    expect(result.tool_calls[0].name).toBe('get_weather');
    expect(result.tool_calls[0].result).toEqual({
      city: 'Paris',
      temperature: 20,
      condition: 'sunny'
    });
    expect(result.output).toEqual({
      result: 'The weather in Paris is sunny, 20 degrees'
    });
  });

  it('should track multiple tool calls', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'tool_a',
      description: 'Tool A',
      parameters: {},
      execute: async () => ({ success: true, output: 'A result' })
    });
    toolRegistry.register({
      name: 'tool_b',
      description: 'Tool B',
      parameters: {},
      execute: async () => ({ success: true, output: 'B result' })
    });

    const mockProvider = new MockProvider([
      {
        content: '',
        tool_calls: [
          { id: 'call-1', name: 'tool_a', arguments: {} }
        ],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      },
      {
        content: '',
        tool_calls: [
          { id: 'call-2', name: 'tool_b', arguments: {} }
        ],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 }
      },
      {
        content: '"Done"',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 }
      }
    ]);

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);

    const result = await runAgent({
      agent: {
        name: 'test-agent',
        provider: 'mock',
        model: 'test-model'
      },
      task: {
        description: 'Run tools'
      },
      context: {},
      toolRegistry,
      providerRegistry
    });

    expect(result.tool_calls_count).toBe(2);
    expect(result.tool_calls[0].name).toBe('tool_a');
    expect(result.tool_calls[1].name).toBe('tool_b');
  });

  it('should track token usage from single response', async () => {
    const mockProvider = new MockProvider([
      {
        content: '{"result": "ok"}',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      },
    ]);

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);
    const toolRegistry = new ToolRegistry();

    const result = await runAgent({
      agent: { name: 'test-agent', provider: 'mock', model: 'test-model' },
      task: { description: 'Test tokens' },
      context: {},
      toolRegistry,
      providerRegistry,
    });

    expect(result.token_usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
  });

  it('should throw at the custom maxToolCalls limit', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'infinite_tool',
      description: 'A tool that always runs',
      parameters: {},
      execute: async () => ({ success: true, output: 'running' }),
    });

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(new InfiniteToolCallProvider());

    await expect(runAgent({
      agent: { name: 'test-agent', provider: 'mock', model: 'test-model' },
      task: { description: 'Run forever' },
      context: {},
      toolRegistry,
      providerRegistry,
      maxToolCalls: 3,
    })).rejects.toThrow('Maximum tool calling iterations (3) reached');
  });

  it('should accumulate token usage across multi-turn tool calls', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'tool_a',
      description: 'Tool A',
      parameters: {},
      execute: async () => ({ success: true, output: 'result' }),
    });

    const mockProvider = new MockProvider([
      {
        content: '',
        tool_calls: [{ id: 'call-1', name: 'tool_a', arguments: {} }],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
      {
        content: '"done"',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 },
      },
    ]);

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);

    const result = await runAgent({
      agent: { name: 'test-agent', provider: 'mock', model: 'test-model' },
      task: { description: 'Test accumulation' },
      context: {},
      toolRegistry,
      providerRegistry,
    });

    expect(result.token_usage).toEqual({
      prompt_tokens: 250,
      completion_tokens: 50,
      total_tokens: 300,
    });
  });
});
