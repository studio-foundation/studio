import { describe, it, expect, vi } from 'vitest';
import { runAgent } from './runner.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { ProviderRegistry } from './providers/registry.js';
import { MockProvider } from './providers/mock.js';
import type { ResolvedAgentConfig, LLMRequest, LLMResponse } from '@studio-foundation/contracts';
import type { Provider } from './providers/provider.js';

/**
 * A minimal Chat Completions-style provider (NOT AgentLoopProvider).
 * First call returns one tool call; second call returns the final content.
 * Tracks the messages received on each call so tests can assert on them.
 */
class StandardProvider implements Provider {
  readonly name = 'standard-mock';
  private callCount = 0;
  public receivedMessages: unknown[] = [];

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.receivedMessages = request.messages as unknown[];
    this.callCount++;
    if (this.callCount === 1) {
      return {
        content: '',
        tool_calls: [{ id: 'call-1', name: 'repo_manager-write_file', arguments: { path: '/tmp/foo.ts', content: 'hello' } }],
        finish_reason: 'tool_calls',
      };
    }
    // Second call: final response
    return {
      content: JSON.stringify({ summary: 'done' }),
      tool_calls: [],
      finish_reason: 'stop',
    };
  }
}

function makeConfig(toolCallName: string, toolCallArgs: Record<string, unknown>) {
  const toolRegistry = new ToolRegistry();
  const mockExecute = vi.fn().mockResolvedValue({ success: true, output: 'wrote file' });
  toolRegistry.register({
    name: toolCallName,
    description: 'A test tool',
    parameters: {
      type: 'object',
      properties: Object.fromEntries(
        Object.keys(toolCallArgs).map(k => [k, { type: 'string' }])
      ),
    },
    execute: mockExecute,
  });

  const mockProvider = new MockProvider(
    new Map([
      ['test-stage', {
        output: { summary: 'done' },
        tool_calls: [{ name: toolCallName, arguments: toolCallArgs }],
      }],
    ])
  );

  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(mockProvider);

  const agent: ResolvedAgentConfig = {
    name: 'test-agent',
    provider: 'mock',
    model: 'mock',
    tools: ['repo_manager-write_file'],
  };

  return { agent, toolRegistry, providerRegistry, mockExecute };
}

/**
 * A Chat Completions-style provider that always returns a tool call — simulates an infinite loop.
 */
class LoopingProvider implements Provider {
  readonly name = 'looping-mock';
  public callCount = 0;

  async call(_request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    return {
      content: '',
      tool_calls: [{ id: `call-${this.callCount}`, name: 'repo_manager-write_file', arguments: { path: '/tmp/foo.ts', content: 'hello' } }],
      finish_reason: 'tool_calls',
    };
  }
}

describe('runner — max tool iterations', () => {
  it('returns an error result instead of throwing when max iterations is reached', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'repo_manager-write_file',
      description: 'Write a file',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
      execute: vi.fn().mockResolvedValue({ success: true }),
    });

    const loopingProvider = new LoopingProvider();
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(loopingProvider);

    const agent: ResolvedAgentConfig = { name: 'test-agent', provider: 'looping-mock', model: 'mock', tools: ['repo_manager-write_file'] };

    const result = await runAgent({
      agent,
      task: { description: 'write a file' },
      context: {},
      toolRegistry,
      providerRegistry,
      maxToolCalls: 3,
    });

    expect(result.error).toBeDefined();
    expect(result.error).toContain('Maximum tool calling iterations');
    expect(result.error).toContain('3');
    expect(loopingProvider.callCount).toBe(3);
  });

  it('includes tool calls made before hitting the limit in the error result', async () => {
    const toolRegistry = new ToolRegistry();
    const mockExecute = vi.fn().mockResolvedValue({ success: true });
    toolRegistry.register({
      name: 'repo_manager-write_file',
      description: 'Write a file',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
      execute: mockExecute,
    });

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(new LoopingProvider());

    const agent: ResolvedAgentConfig = { name: 'test-agent', provider: 'looping-mock', model: 'mock', tools: ['repo_manager-write_file'] };

    const result = await runAgent({
      agent,
      task: { description: 'write a file' },
      context: {},
      toolRegistry,
      providerRegistry,
      maxToolCalls: 2,
    });

    expect(result.error).toBeDefined();
    expect(result.tool_calls).toHaveLength(2);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });
});

describe('runner — onPreToolUse callback', () => {
  it('blocks tool execution when callback returns blocked: true', async () => {
    const { agent, toolRegistry, providerRegistry, mockExecute } = makeConfig(
      'repo_manager-write_file',
      { path: '/tmp/foo.ts', content: 'hello' }
    );

    const onPreToolUse = vi.fn().mockResolvedValue({ blocked: true, error: 'pre-hook blocked' });

    const result = await runAgent({
      agent,
      task: { description: 'write a file', contract_name: 'test-stage' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: { onPreToolUse },
    });

    // Tool should appear in tool_calls with error (not actually executed)
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].error).toContain('pre-hook blocked');
    expect(result.tool_calls[0].result).toBeUndefined();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('allows tool execution when callback returns blocked: false', async () => {
    const { agent, toolRegistry, providerRegistry, mockExecute } = makeConfig(
      'repo_manager-write_file',
      { path: '/tmp/foo.ts', content: 'hello' }
    );

    const onPreToolUse = vi.fn().mockResolvedValue({ blocked: false });

    const result = await runAgent({
      agent,
      task: { description: 'write a file', contract_name: 'test-stage' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: { onPreToolUse },
    });

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].result).toBe('wrote file');
    expect(mockExecute).toHaveBeenCalledOnce();
  });

  it('blocks tool execution in standard (Chat Completions) path', async () => {
    const toolRegistry = new ToolRegistry();
    const mockExecute = vi.fn().mockResolvedValue({ success: true, output: 'wrote file' });
    toolRegistry.register({
      name: 'repo_manager-write_file',
      description: 'A test tool',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
      },
      execute: mockExecute,
    });

    const standardProvider = new StandardProvider();
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(standardProvider);

    const agent: ResolvedAgentConfig = {
      name: 'test-agent',
      provider: 'standard-mock',
      model: 'mock',
      tools: ['repo_manager-write_file'],
    };

    const onPreToolUse = vi.fn().mockResolvedValue({ blocked: true, error: 'standard-path blocked' });

    const result = await runAgent({
      agent,
      task: { description: 'write a file', contract_name: 'test-stage' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: { onPreToolUse },
    });

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].error).toContain('standard-path blocked');
    expect(result.tool_calls[0].result).toBeUndefined();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('runner — onPostToolUse callback', () => {
  it('is called after successful tool execution', async () => {
    const { agent, toolRegistry, providerRegistry } = makeConfig(
      'repo_manager-write_file',
      { path: '/tmp/foo.ts', content: 'hello' }
    );

    const onPostToolUse = vi.fn().mockResolvedValue({});

    await runAgent({
      agent,
      task: { description: 'write a file', contract_name: 'test-stage' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: { onPostToolUse },
    });

    expect(onPostToolUse).toHaveBeenCalledOnce();
    expect(onPostToolUse.mock.calls[0][0]).toMatchObject({
      tool: 'repo_manager-write_file',
      params: { path: '/tmp/foo.ts', content: 'hello' },
      result: 'wrote file',
    });
  });

  it('appends hook message to conversation when returned (standard path — no-op in agent loop)', async () => {
    // The MockProvider uses the agent loop path, so append_message is a no-op here.
    // This test verifies onPostToolUse IS called and no error is thrown.
    const { agent, toolRegistry, providerRegistry } = makeConfig(
      'repo_manager-write_file',
      { path: '/tmp/foo.ts', content: 'hello' }
    );

    const onPostToolUse = vi.fn().mockResolvedValue({
      append_message: 'prettier ran successfully',
    });

    const result = await runAgent({
      agent,
      task: { description: 'write a file', contract_name: 'test-stage' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: { onPostToolUse },
    });

    expect(onPostToolUse).toHaveBeenCalled();
    // Result still succeeds
    expect(result.tool_calls_count).toBe(1);
  });

  it('injects append_message into conversation in standard (Chat Completions) path', async () => {
    const toolRegistry = new ToolRegistry();
    const mockExecute = vi.fn().mockResolvedValue({ success: true, output: 'wrote file' });
    toolRegistry.register({
      name: 'repo_manager-write_file',
      description: 'A test tool',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
      },
      execute: mockExecute,
    });

    const standardProvider = new StandardProvider();
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(standardProvider);

    const agent: ResolvedAgentConfig = {
      name: 'test-agent',
      provider: 'standard-mock',
      model: 'mock',
      tools: ['repo_manager-write_file'],
    };

    const onPostToolUse = vi.fn().mockResolvedValue({
      append_message: 'prettier ran and formatted the file',
    });

    const result = await runAgent({
      agent,
      task: { description: 'write a file', contract_name: 'test-stage' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: { onPostToolUse },
    });

    expect(onPostToolUse).toHaveBeenCalledOnce();
    expect(result.tool_calls_count).toBe(1);

    // Verify the post-hook message was injected into the conversation.
    // The second call to provider.call() should include the tool result message with the append.
    const secondCallMessages = standardProvider.receivedMessages as Array<{ role: string; content: string }>;
    const toolResultMessage = secondCallMessages.find(m => m.role === 'user' && m.content.includes('Tool execution results'));
    expect(toolResultMessage?.content).toContain('Post-hook note: prettier ran and formatted the file');
  });
});
