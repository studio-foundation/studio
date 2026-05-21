/**
 * Runner tests with mock provider
 */

import { describe, it, expect } from 'vitest';
import { runAgent, UNAUTHORIZED_TOOL_ERROR_PREFIX } from '../src/runner.js';
import type { Provider } from '../src/providers/provider.js';
import type { LLMRequest, LLMResponse } from '@studio-foundation/contracts';
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

  async call(request: LLMRequest, _onToken?: (token: string) => void): Promise<LLMResponse> {
    if (this.currentIndex >= this.responses.length) {
      throw new Error('Mock provider ran out of responses');
    }
    return this.responses[this.currentIndex++];
  }
}

// Provider that always returns a tool call (infinite loop simulation)
class InfiniteToolCallProvider implements Provider {
  readonly name = 'mock';

  async call(_request: LLMRequest, _onToken?: (token: string) => void): Promise<LLMResponse> {
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
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
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
        model: 'test-model',
        tools: ['get_weather'],
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
        model: 'test-model',
        tools: ['tool_a', 'tool_b'],
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

  it('should return an error result (not throw) at the custom maxToolCalls limit', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'infinite_tool',
      description: 'A tool that always runs',
      parameters: {},
      execute: async () => ({ success: true, output: 'running' }),
    });

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(new InfiniteToolCallProvider());

    const result = await runAgent({
      agent: { name: 'test-agent', provider: 'mock', model: 'test-model', tools: ['infinite_tool'] },
      task: { description: 'Run forever' },
      context: {},
      toolRegistry,
      providerRegistry,
      maxToolCalls: 3,
    });

    expect(result.error).toBeDefined();
    expect(result.error).toContain('Maximum tool calling iterations (3) reached');
    expect(result.tool_calls).toHaveLength(3);
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
      agent: { name: 'test-agent', provider: 'mock', model: 'test-model', tools: ['tool_a'] },
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

describe('runAgent — callbacks', () => {
  it('calls onToolCallStart and onToolCallComplete for each tool call', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'echo_tool',
      description: 'Echoes input',
      parameters: {
        type: 'object',
        properties: { msg: { type: 'string' } },
      },
      execute: async (args) => ({ success: true, output: args }),
    });

    const mockProvider = new MockProvider([
      {
        content: '',
        tool_calls: [{ id: 'tc-1', name: 'echo_tool', arguments: { msg: 'hello' } }],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        content: '"done"',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
    ]);

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);

    const startEvents: import('@studio-foundation/contracts').ToolCallStartEvent[] = [];
    const completeEvents: import('@studio-foundation/contracts').ToolCallCompleteEvent[] = [];

    await runAgent({
      agent: { name: 'test-agent', provider: 'mock', model: 'test-model', tools: ['echo_tool'] },
      task: { description: 'Test callbacks' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: {
        onToolCallStart: (e) => startEvents.push(e),
        onToolCallComplete: (e) => completeEvents.push(e),
      },
    });

    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].tool).toBe('echo_tool');
    expect(startEvents[0].params).toEqual({ msg: 'hello' });
    expect(startEvents[0].timestamp).toBeTypeOf('number');

    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0].tool).toBe('echo_tool');
    expect(completeEvents[0].result).toEqual({ msg: 'hello' });
    expect(completeEvents[0].error).toBeUndefined();
    expect(completeEvents[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('includes error in onToolCallComplete when tool fails', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'broken_tool',
      description: 'Always fails',
      parameters: {},
      execute: async () => ({ success: false, error: 'something went wrong' }),
    });

    const mockProvider = new MockProvider([
      {
        content: '',
        tool_calls: [{ id: 'tc-1', name: 'broken_tool', arguments: {} }],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        content: '"recovered"',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
    ]);

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);

    const completeEvents: import('@studio-foundation/contracts').ToolCallCompleteEvent[] = [];

    await runAgent({
      agent: { name: 'test-agent', provider: 'mock', model: 'test-model', tools: ['broken_tool'] },
      task: { description: 'Test error callback' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: {
        onToolCallComplete: (e) => completeEvents.push(e),
      },
    });

    expect(completeEvents[0].error).toBe('something went wrong');
    expect(completeEvents[0].result).toBeUndefined();
  });

  it('calls callbacks in agent-loop provider path', async () => {
    // AgentLoopProvider mock — owns the full loop and calls executeTool
    const agentLoopProvider: import('../src/providers/provider.js').AgentLoopProvider = {
      name: 'mock-loop',
      call: async () => { throw new Error('not used'); },
      runAgentLoop: async (_req, executeTool) => {
        const outcome = await executeTool('loop_tool', { x: 1 }, 'call-loop-1');
        return {
          content: '"loop done"',
          tool_calls: [{ id: 'call-loop-1', name: 'loop_tool', arguments: { x: 1 }, ...outcome }],
          finish_reason: 'stop',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      },
    };

    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'loop_tool',
      description: 'Loop path tool',
      parameters: {
        type: 'object',
        properties: { x: { type: 'number' } },
      },
      execute: async (args) => ({ success: true, output: args }),
    });

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(agentLoopProvider);

    const startEvents: import('@studio-foundation/contracts').ToolCallStartEvent[] = [];
    const completeEvents: import('@studio-foundation/contracts').ToolCallCompleteEvent[] = [];

    await runAgent({
      agent: { name: 'test-agent', provider: 'mock-loop', model: 'test-model', tools: ['loop_tool'] },
      task: { description: 'Test loop callbacks' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: {
        onToolCallStart: (e) => startEvents.push(e),
        onToolCallComplete: (e) => completeEvents.push(e),
      },
    });

    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].tool).toBe('loop_tool');
    expect(startEvents[0].params).toEqual({ x: 1 });
    expect(startEvents[0].timestamp).toBeTypeOf('number');
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0].tool).toBe('loop_tool');
    expect(completeEvents[0].result).toEqual({ x: 1 });
    expect(completeEvents[0].error).toBeUndefined();
    expect(completeEvents[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits onAgentThinking when first-turn LLM text accompanies tool calls', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'fetch_data',
      description: 'Fetches data',
      parameters: {},
      execute: async () => ({ success: true, output: 'data' }),
    });

    const mockProvider = new MockProvider([
      {
        content: 'Let me fetch the data for you.',
        tool_calls: [{ id: 'tc-1', name: 'fetch_data', arguments: {} }],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        content: '"done"',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
    ]);

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);

    const thinkingEvents: import('@studio-foundation/contracts').AgentThinkingEvent[] = [];
    const progressEvents: import('@studio-foundation/contracts').AgentProgressEvent[] = [];

    await runAgent({
      agent: { name: 'test-agent', provider: 'mock', model: 'test-model', tools: ['fetch_data'] },
      task: { description: 'Fetch data' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: {
        onAgentThinking: (e) => thinkingEvents.push(e),
        onAgentProgress: (e) => progressEvents.push(e),
      },
    });

    expect(thinkingEvents).toHaveLength(1);
    expect(thinkingEvents[0].thought).toBe('Let me fetch the data for you.');
    expect(thinkingEvents[0].timestamp).toBeTypeOf('number');
    expect(progressEvents).toHaveLength(0);
  });

  it('emits onAgentProgress (not onAgentThinking) for text in subsequent turns', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'step_a',
      description: 'Step A',
      parameters: {},
      execute: async () => ({ success: true, output: 'a' }),
    });
    toolRegistry.register({
      name: 'step_b',
      description: 'Step B',
      parameters: {},
      execute: async () => ({ success: true, output: 'b' }),
    });

    const mockProvider = new MockProvider([
      // Turn 0: thinking text + first tool call
      {
        content: 'Starting with step A.',
        tool_calls: [{ id: 'tc-1', name: 'step_a', arguments: {} }],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      // Turn 1: progress text + second tool call
      {
        content: 'Now moving to step B.',
        tool_calls: [{ id: 'tc-2', name: 'step_b', arguments: {} }],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      },
      // Final
      {
        content: '"complete"',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
      },
    ]);

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);

    const thinkingEvents: import('@studio-foundation/contracts').AgentThinkingEvent[] = [];
    const progressEvents: import('@studio-foundation/contracts').AgentProgressEvent[] = [];

    await runAgent({
      agent: { name: 'test-agent', provider: 'mock', model: 'test-model', tools: ['step_a', 'step_b'] },
      task: { description: 'Two-step task' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: {
        onAgentThinking: (e) => thinkingEvents.push(e),
        onAgentProgress: (e) => progressEvents.push(e),
      },
    });

    expect(thinkingEvents).toHaveLength(1);
    expect(thinkingEvents[0].thought).toBe('Starting with step A.');

    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0].message).toBe('Now moving to step B.');
  });

  it('does not emit thinking/progress when LLM text is empty alongside tool calls', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'silent_tool',
      description: 'Silent tool',
      parameters: {},
      execute: async () => ({ success: true, output: 'done' }),
    });

    const mockProvider = new MockProvider([
      {
        content: '',
        tool_calls: [{ id: 'tc-1', name: 'silent_tool', arguments: {} }],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
      {
        content: '"ok"',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 },
      },
    ]);

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);

    const thinkingEvents: import('@studio-foundation/contracts').AgentThinkingEvent[] = [];

    await runAgent({
      agent: { name: 'test-agent', provider: 'mock', model: 'test-model', tools: ['silent_tool'] },
      task: { description: 'Silent' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: { onAgentThinking: (e) => thinkingEvents.push(e) },
    });

    expect(thinkingEvents).toHaveLength(0);
  });

  it('should propagate onAgentToken when provider emits tokens', async () => {
    const receivedTokens: string[] = [];

    class TokenStreamingProvider implements Provider {
      readonly name = 'mock';
      async call(_request: LLMRequest, onToken?: (token: string) => void): Promise<LLMResponse> {
        onToken?.('Hello');
        onToken?.(' world');
        return {
          content: '{"result": "streamed"}',
          tool_calls: [],
          finish_reason: 'stop',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      }
    }

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(new TokenStreamingProvider());
    const toolRegistry = new ToolRegistry();

    await runAgent({
      agent: { name: 'test-agent', provider: 'mock', model: 'test-model' },
      task: { description: 'stream test' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: {
        onAgentToken: (event) => receivedTokens.push(event.token),
      },
    });

    expect(receivedTokens).toEqual(['Hello', ' world']);
  });

  it('works fine when no callbacks are provided', async () => {
    const mockProvider = new MockProvider([
      {
        content: '"ok"',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    ]);
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);

    await expect(
      runAgent({
        agent: { name: 'test-agent', provider: 'mock', model: 'test-model' },
        task: { description: 'No callbacks' },
        context: {},
        toolRegistry: new ToolRegistry(),
        providerRegistry,
      })
    ).resolves.toBeDefined();
  });
});

describe('runAgent — abort signal', () => {
  it('throws AbortError when signal is aborted before LLM call', async () => {
    const controller = new AbortController();
    controller.abort();

    const mockProvider = new MockProvider([
      {
        content: '"ok"',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    ]);
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);

    await expect(
      runAgent({
        agent: { name: 'test-agent', provider: 'mock', model: 'test-model' },
        task: { description: 'test' },
        context: {},
        toolRegistry: new ToolRegistry(),
        providerRegistry,
        signal: controller.signal,
      })
    ).rejects.toThrow();
  });

  it('throws when signal aborts between tool call turns', async () => {
    const controller = new AbortController();

    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'test_tool',
      description: 'Test',
      parameters: {},
      execute: async () => {
        controller.abort();
        return { success: true, output: 'done' };
      },
    });

    const mockProvider = new MockProvider([
      {
        content: '',
        tool_calls: [{ id: 'tc1', name: 'test_tool', arguments: {} }],
        finish_reason: 'tool_use',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        content: '"ok"',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ]);
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);

    await expect(
      runAgent({
        agent: { name: 'test-agent', provider: 'mock', model: 'test-model', tools: ['test_tool'] },
        task: { description: 'test' },
        context: {},
        toolRegistry,
        providerRegistry,
        signal: controller.signal,
      })
    ).rejects.toThrow();
  });
});

describe('runAgent — tool_calls_count semantics', () => {
  it('excludes failed tool calls from tool_calls_count (standard path)', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'broken_tool',
      description: 'Always fails',
      parameters: {},
      execute: async () => ({ success: false, error: 'tool error' }),
    });

    const mockProvider = new MockProvider([
      {
        content: '',
        tool_calls: [{ id: 'tc-1', name: 'broken_tool', arguments: {} }],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        content: '"recovered"',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
    ]);

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);

    const result = await runAgent({
      agent: { name: 'test-agent', provider: 'mock', model: 'test-model', tools: ['broken_tool'] },
      task: { description: 'test failed tool' },
      context: {},
      toolRegistry,
      providerRegistry,
    });

    // tool_calls still records the attempt
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].error).toBe('tool error');
    // tool_calls_count only counts successful calls
    expect(result.tool_calls_count).toBe(0);
  });

  it('counts only successful calls in a mixed-result batch (standard path)', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'good_tool',
      description: 'Succeeds',
      parameters: {},
      execute: async () => ({ success: true, output: 'ok' }),
    });
    toolRegistry.register({
      name: 'bad_tool',
      description: 'Fails',
      parameters: {},
      execute: async () => ({ success: false, error: 'bad' }),
    });

    const mockProvider = new MockProvider([
      {
        content: '',
        tool_calls: [
          { id: 'tc-1', name: 'good_tool', arguments: {} },
          { id: 'tc-2', name: 'bad_tool', arguments: {} },
        ],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        content: '"done"',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
    ]);

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);

    const result = await runAgent({
      agent: { name: 'test-agent', provider: 'mock', model: 'test-model', tools: ['good_tool', 'bad_tool'] },
      task: { description: 'mixed tools' },
      context: {},
      toolRegistry,
      providerRegistry,
    });

    expect(result.tool_calls).toHaveLength(2);
    expect(result.tool_calls_count).toBe(1); // only good_tool succeeded
  });

  it('excludes failed tool calls from tool_calls_count (agent-loop path)', async () => {
    const agentLoopProvider: import('../src/providers/provider.js').AgentLoopProvider = {
      name: 'mock-loop',
      call: async () => { throw new Error('not used'); },
      runAgentLoop: async (_req, executeTool) => {
        const outcome = await executeTool('failing_loop_tool', {}, 'call-fail-1');
        return {
          content: '"recovered"',
          tool_calls: [{ id: 'call-fail-1', name: 'failing_loop_tool', arguments: {}, ...outcome }],
          finish_reason: 'stop',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      },
    };

    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'failing_loop_tool',
      description: 'Always fails in loop',
      parameters: {},
      execute: async () => ({ success: false, error: 'loop tool failed' }),
    });

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(agentLoopProvider);

    const result = await runAgent({
      agent: { name: 'test-agent', provider: 'mock-loop', model: 'test-model', tools: ['failing_loop_tool'] },
      task: { description: 'test loop fail' },
      context: {},
      toolRegistry,
      providerRegistry,
    });

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].error).toBe('loop tool failed');
    expect(result.tool_calls_count).toBe(0);
  });
});

describe('tool whitelist enforcement', () => {
  function makeTool(name: string) {
    return {
      name,
      description: `Tool ${name}`,
      parameters: {},
      execute: async () => ({ success: true, result: `${name}-result` }),
    };
  }

  it('exposes only declared tools to the LLM when tools is a non-empty list', async () => {
    const capturedRequests: LLMRequest[] = [];
    const provider: Provider = {
      name: 'mock-whitelist',
      async call(req, _onToken) {
        capturedRequests.push(req);
        return { content: '{}', tool_calls: [], finish_reason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      },
    };

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool('allowed-tool'));
    toolRegistry.register(makeTool('forbidden-tool'));

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(provider);

    await runAgent({
      agent: { name: 'test-agent', provider: 'mock-whitelist', model: 'test-model', tools: ['allowed-tool'] },
      task: { description: 'test whitelist' },
      context: {},
      toolRegistry,
      providerRegistry,
    });

    expect(capturedRequests).toHaveLength(1);
    const sentTools = capturedRequests[0].tools ?? [];
    expect(sentTools.map(t => t.name)).toContain('allowed-tool');
    expect(sentTools.map(t => t.name)).not.toContain('forbidden-tool');
  });

  it('exposes no tools when tools is an empty array', async () => {
    const capturedRequests: LLMRequest[] = [];
    const provider: Provider = {
      name: 'mock-empty',
      async call(req, _onToken) {
        capturedRequests.push(req);
        return { content: '{}', tool_calls: [], finish_reason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      },
    };

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool('some-tool'));

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(provider);

    await runAgent({
      agent: { name: 'test-agent', provider: 'mock-empty', model: 'test-model', tools: [] },
      task: { description: 'test empty whitelist' },
      context: {},
      toolRegistry,
      providerRegistry,
    });

    expect(capturedRequests[0].tools).toBeUndefined();
  });

  it('exposes no tools when tools field is absent', async () => {
    const capturedRequests: LLMRequest[] = [];
    const provider: Provider = {
      name: 'mock-absent',
      async call(req, _onToken) {
        capturedRequests.push(req);
        return { content: '{}', tool_calls: [], finish_reason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      },
    };

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool('some-tool'));

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(provider);

    await runAgent({
      agent: { name: 'test-agent', provider: 'mock-absent', model: 'test-model' }, // no tools field
      task: { description: 'test absent tools' },
      context: {},
      toolRegistry,
      providerRegistry,
    });

    expect(capturedRequests[0].tools).toBeUndefined();
  });

  it('fails the stage when agent hallucinates a tool not in its whitelist', async () => {
    // Provider calls a tool not in the agent's declared whitelist
    const provider: Provider = {
      name: 'mock-hallucinate',
      async call(_req, _onToken) {
        return {
          content: '',
          tool_calls: [{ id: 'call-1', name: 'forbidden-tool', arguments: {} }],
          finish_reason: 'tool_calls',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
    };

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool('allowed-tool'));
    toolRegistry.register(makeTool('forbidden-tool'));

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(provider);

    const result = await runAgent({
      agent: { name: 'test-agent', provider: 'mock-hallucinate', model: 'test-model', tools: ['allowed-tool'] },
      task: { description: 'test hallucination' },
      context: {},
      toolRegistry,
      providerRegistry,
    });

    expect(result.error).toBeDefined();
    expect(result.error).toContain(UNAUTHORIZED_TOOL_ERROR_PREFIX);
    expect(result.error).toContain('forbidden-tool');
    expect(result.tool_calls_count).toBe(0);
  });
});
