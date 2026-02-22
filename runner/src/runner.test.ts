import { describe, it, expect, vi } from 'vitest';
import { runAgent } from './runner.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { ProviderRegistry } from './providers/registry.js';
import { MockProvider } from './providers/mock.js';
import type { AgentConfig } from '@studio/contracts';

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

  const agent: AgentConfig = {
    name: 'test-agent',
    provider: 'mock',
    model: 'mock',
  };

  return { agent, toolRegistry, providerRegistry, mockExecute };
}

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
});
