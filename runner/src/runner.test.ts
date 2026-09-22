import { describe, it, expect, vi } from 'vitest';
import { runAgent } from './runner.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { ProviderRegistry } from './providers/registry.js';
import { MockProvider } from './providers/mock.js';
import type { ResolvedAgentConfig, LLMRequest, LLMResponse, Message } from '@studio-foundation/contracts';
import type { Provider, AgentLoopProvider, AgentLoopResult, ToolCallOutcome } from './providers/provider.js';

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

/**
 * Reports usage on every turn, with a different model on the second — the shape
 * a multi-turn tool-calling stage produces.
 */
class MeteredProvider implements Provider {
  readonly name = 'metered-mock';
  private callCount = 0;

  async call(_request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    if (this.callCount === 1) {
      return {
        content: '',
        tool_calls: [{ id: 'call-1', name: 'repo_manager-write_file', arguments: { path: '/tmp/foo.ts', content: 'hi' } }],
        finish_reason: 'tool_calls',
        usage: {
          prompt_tokens: 100, completion_tokens: 20, total_tokens: 170,
          cached_input_tokens: 40, cache_creation_tokens: 10,
          by_model: {
            'model-a': {
              prompt_tokens: 100, completion_tokens: 20, total_tokens: 170,
              cached_input_tokens: 40, cache_creation_tokens: 10,
            },
          },
        },
      };
    }
    return {
      content: JSON.stringify({ summary: 'done' }),
      tool_calls: [],
      finish_reason: 'stop',
      usage: {
        prompt_tokens: 5, completion_tokens: 3, total_tokens: 8,
        by_model: { 'model-b': { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
      },
    };
  }
}

describe('runner — token usage (STU-750)', () => {
  it('sums every turn, keeping the cache split and the per-model breakdown', async () => {
    const { agent, toolRegistry } = makeConfig('repo_manager-write_file', { path: '', content: '' });
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(new MeteredProvider());

    const result = await runAgent({
      agent: { ...agent, provider: 'metered-mock' },
      task: { description: 'test' },
      context: {},
      toolRegistry,
      providerRegistry,
    });

    expect(result.token_usage).toEqual({
      prompt_tokens: 105,
      completion_tokens: 23,
      total_tokens: 178,
      cached_input_tokens: 40,
      cache_creation_tokens: 10,
      by_model: {
        'model-a': {
          prompt_tokens: 100, completion_tokens: 20, total_tokens: 170,
          cached_input_tokens: 40, cache_creation_tokens: 10,
        },
        'model-b': { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    });
  });

  it('leaves token_usage absent when no provider reported any', async () => {
    const { agent, toolRegistry } = makeConfig('repo_manager-write_file', { path: '', content: '' });
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(new StandardProvider());

    const result = await runAgent({
      agent: { ...agent, provider: 'standard-mock' },
      task: { description: 'test' },
      context: {},
      toolRegistry,
      providerRegistry,
    });

    expect(result.token_usage).toBeUndefined();
  });
});

/** Records the `cache_prompt` flag the runner put on every request. */
class CacheFlagProvider implements Provider {
  readonly name = 'cache-flag-mock';
  public flags: Array<boolean | undefined> = [];
  private callCount = 0;

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.flags.push(request.cache_prompt);
    this.callCount++;
    if (this.callCount === 1) {
      return {
        content: '',
        tool_calls: [{ id: 'call-1', name: 'repo_manager-write_file', arguments: { path: '/tmp/foo.ts', content: 'hi' } }],
        finish_reason: 'tool_calls',
      };
    }
    return { content: JSON.stringify({ summary: 'done' }), tool_calls: [], finish_reason: 'stop' };
  }
}

describe('runner — prompt cache decision (STU-752)', () => {
  async function flagsFor(overrides: Partial<Parameters<typeof runAgent>[0]>) {
    const { agent, toolRegistry } = makeConfig('repo_manager-write_file', { path: '', content: '' });
    const provider = new CacheFlagProvider();
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(provider);

    await runAgent({
      agent: { ...agent, provider: 'cache-flag-mock' },
      task: { description: 'test' },
      context: {},
      toolRegistry,
      providerRegistry,
      ...overrides,
    });
    return provider.flags;
  }

  it('asks for no cache when nothing obliges the stage to call tools', async () => {
    expect(await flagsFor({})).toEqual([false, false]);
  });

  it('asks for a cache when the contract requires tool calls', async () => {
    const flags = await flagsFor({
      outputContract: { name: 'code-generation', version: 1, tool_calls: { minimum: 1 } },
    });
    // Same answer on every turn — turn 2 reads what turn 1 wrote.
    expect(flags).toEqual([true, true]);
  });

  it('honours the agent-level override', async () => {
    const { agent, toolRegistry } = makeConfig('repo_manager-write_file', { path: '', content: '' });
    const provider = new CacheFlagProvider();
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(provider);

    await runAgent({
      agent: { ...agent, provider: 'cache-flag-mock', prompt_cache: 'on' },
      task: { description: 'test' },
      context: {},
      toolRegistry,
      providerRegistry,
    });

    expect(provider.flags).toEqual([true, true]);
  });
});

/**
 * A provider that never resolves on its own — simulates a wedged `claude --print`
 * or a stuck HTTP call. Only settles when its `signal` aborts, the same contract
 * every real provider (fetch, child_process) honors.
 */
class HangingProvider implements Provider {
  readonly name = 'hanging-mock';
  public sawAbort = false;

  call(_request: LLMRequest, _onToken?: (token: string) => void, signal?: AbortSignal): Promise<LLMResponse> {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        this.sawAbort = true;
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }
}

describe('runner — timeout_ms on agent stages (STU-1485)', () => {
  function hangingConfig() {
    const toolRegistry = new ToolRegistry();
    const provider = new HangingProvider();
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(provider);
    const agent: ResolvedAgentConfig = { name: 'test-agent', provider: 'hanging-mock', model: 'mock' };
    return { agent, toolRegistry, providerRegistry, provider };
  }

  it('returns a failed-attempt result instead of hanging or throwing', async () => {
    const { agent, toolRegistry, providerRegistry } = hangingConfig();

    const result = await runAgent({
      agent,
      task: { description: 'x' },
      context: {},
      toolRegistry,
      providerRegistry,
      timeoutMs: 20,
    });

    expect(result.error).toBe('Agent timed out after 20ms');
    expect(result.output).toBeNull();
  });

  it('aborts the provider call, not just the wait', async () => {
    const { agent, toolRegistry, providerRegistry, provider } = hangingConfig();

    await runAgent({
      agent,
      task: { description: 'x' },
      context: {},
      toolRegistry,
      providerRegistry,
      timeoutMs: 20,
    });

    expect(provider.sawAbort).toBe(true);
  });

  it('does not fire when the call finishes well within the timeout', async () => {
    const { agent, toolRegistry, providerRegistry } = makeConfig(
      'repo_manager-write_file',
      { path: '/tmp/foo.ts', content: 'hello' }
    );

    const result = await runAgent({
      agent,
      task: { description: 'write a file', contract_name: 'test-stage' },
      context: {},
      toolRegistry,
      providerRegistry,
      timeoutMs: 5000,
    });

    expect(result.error).toBeUndefined();
  });

  it('leaves agent stages with no timeout at all when timeout_ms is unset', async () => {
    // Same hanging provider, but no timeoutMs — must not resolve on its own.
    // Racing it against a short delay proves runAgent is still pending, not that
    // it "completed" with nothing to assert.
    const { agent, toolRegistry, providerRegistry } = hangingConfig();

    const outcome = await Promise.race([
      runAgent({ agent, task: { description: 'x' }, context: {}, toolRegistry, providerRegistry })
        .then(() => 'resolved' as const),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 30)),
    ]);

    expect(outcome).toBe('still-pending');
  });

  it('still throws (does not swallow) a real cancellation via the caller-supplied signal', async () => {
    const { agent, toolRegistry, providerRegistry } = hangingConfig();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    await expect(runAgent({
      agent,
      task: { description: 'x' },
      context: {},
      toolRegistry,
      providerRegistry,
      timeoutMs: 5000, // generous — the external signal must win, not the timeout
      signal: controller.signal,
    })).rejects.toThrow('Aborted');
  });
});

/** An AgentLoopProvider (e.g. claude-code) that reports a provider-side failure. */
class FailingLoopProvider implements AgentLoopProvider {
  readonly name = 'failing-loop-mock';
  constructor(private readonly errorMessage: string) {}

  async call(): Promise<LLMResponse> {
    throw new Error('use runAgentLoop');
  }

  async runAgentLoop(
    _request: LLMRequest,
    _executeTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<ToolCallOutcome>,
  ): Promise<AgentLoopResult> {
    return { content: '', tool_calls: [], finish_reason: 'error', error: this.errorMessage };
  }
}

describe('runner — AgentLoopProvider error field (STU-1488)', () => {
  it('returns a failed-attempt result instead of throwing when the provider resolves with error set', async () => {
    const toolRegistry = new ToolRegistry();
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(new FailingLoopProvider('Provider API error: Internal server error'));
    const agent: ResolvedAgentConfig = { name: 'test-agent', provider: 'failing-loop-mock', model: 'mock' };

    const result = await runAgent({
      agent,
      task: { description: 'x' },
      context: {},
      toolRegistry,
      providerRegistry,
    });

    expect(result.error).toBe('Provider API error: Internal server error');
    expect(result.output).toBeNull();
  });
});

/** A Chat Completions-style provider whose call rejects, the way an SDK raises a network error. */
class ThrowingProvider implements Provider {
  readonly name = 'throwing-mock';
  public callCount = 0;

  async call(_request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    throw new Error('fetch failed: ECONNRESET');
  }
}

/** An AgentLoopProvider that rejects instead of resolving with `error` set. */
class ThrowingLoopProvider implements AgentLoopProvider {
  readonly name = 'throwing-loop-mock';

  async call(): Promise<LLMResponse> {
    throw new Error('use runAgentLoop');
  }

  async runAgentLoop(): Promise<AgentLoopResult> {
    throw new Error('429 rate_limit_error');
  }
}

/** Runs one tool, reports usage, then throws on the next turn. */
class ThrowsAfterToolCallProvider implements Provider {
  readonly name = 'throws-after-tool-mock';
  private callCount = 0;

  async call(_request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    if (this.callCount === 1) {
      return {
        content: '',
        tool_calls: [{ id: 'call-1', name: 'repo_manager-write_file', arguments: { path: '/tmp/foo.ts', content: 'hi' } }],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    }
    throw new Error('socket hang up');
  }
}

describe('runner — provider throws are retry-eligible failed attempts (STU-1489)', () => {
  function registryOf(provider: Provider) {
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(provider as never);
    return providerRegistry;
  }

  it('returns an error result instead of rejecting when the multi-turn provider.call() throws', async () => {
    const provider = new ThrowingProvider();
    const agent: ResolvedAgentConfig = { name: 'test-agent', provider: 'throwing-mock', model: 'mock' };

    const result = await runAgent({
      agent,
      task: { description: 'x' },
      context: {},
      toolRegistry: new ToolRegistry(),
      providerRegistry: registryOf(provider),
    });

    expect(result.error).toContain('fetch failed: ECONNRESET');
    expect(result.output).toBeNull();
    expect(provider.callCount).toBe(1);
  });

  it('returns an error result instead of rejecting when an AgentLoopProvider throws', async () => {
    const agent: ResolvedAgentConfig = { name: 'test-agent', provider: 'throwing-loop-mock', model: 'mock' };

    const result = await runAgent({
      agent,
      task: { description: 'x' },
      context: {},
      toolRegistry: new ToolRegistry(),
      providerRegistry: registryOf(new ThrowingLoopProvider()),
    });

    expect(result.error).toContain('429 rate_limit_error');
    expect(result.output).toBeNull();
  });

  it('keeps the tool calls and tokens the failed attempt already spent', async () => {
    const { agent, toolRegistry } = makeConfig('repo_manager-write_file', { path: '', content: '' });

    const result = await runAgent({
      agent: { ...agent, provider: 'throws-after-tool-mock' },
      task: { description: 'x' },
      context: {},
      toolRegistry,
      providerRegistry: registryOf(new ThrowsAfterToolCallProvider()),
    });

    expect(result.error).toContain('socket hang up');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls_count).toBe(1);
    expect(result.token_usage?.total_tokens).toBe(15);
  });

  it('still throws a real cancellation rather than reporting it as a failed attempt', async () => {
    const controller = new AbortController();
    const agent: ResolvedAgentConfig = { name: 'test-agent', provider: 'hanging-mock', model: 'mock' };
    const provider = new HangingProvider();
    setTimeout(() => controller.abort(), 10);

    await expect(runAgent({
      agent,
      task: { description: 'x' },
      context: {},
      toolRegistry: new ToolRegistry(),
      providerRegistry: registryOf(provider),
      signal: controller.signal,
    })).rejects.toThrow('Aborted');
  });
});

/**
 * A Chat Completions-style provider whose reported prompt_tokens escalate turn by
 * turn — the shape a stage grows into as its tool-calling loop keeps going.
 * Calls 1-4 make a tool call (usage.prompt_tokens: 10, 30, 60, 20); call 5 is final.
 */
class GrowingProvider implements Provider {
  readonly name = 'growing-mock';
  public callCount = 0;
  public receivedMessagesPerCall: Message[][] = [];
  private readonly promptTokens = [10, 30, 60, 20];

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    this.receivedMessagesPerCall.push(request.messages as Message[]);
    if (this.callCount <= 4) {
      const promptTokens = this.promptTokens[this.callCount - 1];
      return {
        content: '',
        tool_calls: [{ id: `call-${this.callCount}`, name: 'repo_manager-write_file', arguments: { path: '/tmp/foo.ts', content: 'hi' } }],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 },
      };
    }
    return {
      content: JSON.stringify({ summary: 'done' }),
      tool_calls: [],
      finish_reason: 'stop',
      usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
    };
  }
}

class SummarizerProvider implements Provider {
  readonly name = 'summarizer-mock';
  public callCount = 0;

  async call(_request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    return {
      content: 'Summary: wrote foo.ts once.',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
    };
  }
}

describe('runner — context compaction (STU-1605)', () => {
  it('compacts exactly once the threshold is crossed, keeping the system prompt, the task and the last N turns verbatim', async () => {
    const { agent, toolRegistry } = makeConfig('repo_manager-write_file', { path: '', content: '' });
    const growingProvider = new GrowingProvider();
    const summarizerProvider = new SummarizerProvider();
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(growingProvider);
    providerRegistry.register(summarizerProvider);

    const compactAgent: ResolvedAgentConfig = { name: 'summarizer', provider: 'summarizer-mock', model: 'mock' };

    const result = await runAgent({
      agent: {
        ...agent,
        provider: 'growing-mock',
        compact: { threshold_tokens: 50, keep_last_turns: 1, summarizer: 'summarizer' },
      },
      task: { description: 'test' },
      context: {},
      toolRegistry,
      providerRegistry,
      compactAgent,
    });

    // Compaction fires once — on the response that crossed the threshold (call 3, 60 tokens) —
    // not on every turn after.
    expect(summarizerProvider.callCount).toBe(1);

    // Turn 4's outgoing request is the first one built from the compacted history.
    const turn4Messages = growingProvider.receivedMessagesPerCall[3];
    expect(turn4Messages[0]).toEqual(growingProvider.receivedMessagesPerCall[0][0]); // system prompt, verbatim
    expect(turn4Messages[1]).toEqual(growingProvider.receivedMessagesPerCall[0][1]); // original task, verbatim
    expect(turn4Messages.some(m => m.content.includes('Summary: wrote foo.ts once.'))).toBe(true);
    expect(turn4Messages.some(m => m.content.includes('call-1'))).toBe(false); // summarized away
    expect(turn4Messages.some(m => m.content.includes('call-2'))).toBe(true);  // kept (last turn as of compaction)
    expect(turn4Messages.some(m => m.content.includes('call-3'))).toBe(true);  // this turn's own

    // The audit trail of tool calls is untouched by compaction — only the LLM-visible
    // conversation is summarized.
    expect(result.tool_calls).toHaveLength(4);

    // The summarizer's own cost is folded into the run's total.
    expect(result.token_usage?.total_tokens).toBe(15 + 35 + 65 + 25 + 20 + 50);
  });

  it('never compacts when the agent has no compact policy', async () => {
    const { agent, toolRegistry } = makeConfig('repo_manager-write_file', { path: '', content: '' });
    const growingProvider = new GrowingProvider();
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(growingProvider);

    await runAgent({
      agent: { ...agent, provider: 'growing-mock' },
      task: { description: 'test' },
      context: {},
      toolRegistry,
      providerRegistry,
    });

    const turn4Messages = growingProvider.receivedMessagesPerCall[3];
    expect(turn4Messages.some(m => m.content.includes('call-1'))).toBe(true); // nothing dropped
  });
});
