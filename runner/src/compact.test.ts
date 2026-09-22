import { describe, it, expect } from 'vitest';
import { compactMessages } from './compact.js';
import { ProviderRegistry } from './providers/registry.js';
import type { Message, LLMRequest, LLMResponse, ResolvedAgentConfig } from '@studio-foundation/contracts';
import type { Provider } from './providers/provider.js';

class RecordingProvider implements Provider {
  readonly name = 'summarizer-mock';
  public callCount = 0;
  public receivedMessages: Message[] = [];

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    this.receivedMessages = request.messages;
    return {
      content: 'Summary: wrote foo.ts once.',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
    };
  }
}

const summarizer: ResolvedAgentConfig = { name: 'summarizer', provider: 'summarizer-mock', model: 'mock' };

function turn(id: string): Message[] {
  return [
    { role: 'assistant', content: '' },
    { role: 'user', content: `Tool execution results:\n\nTool x (id: ${id}) result: {}` },
  ];
}

/** True when no two consecutive messages share a role — required by providers (e.g. Anthropic) that reject it. */
function alternates(messages: Message[]): boolean {
  return messages.every((m, i) => i === 0 || m.role !== messages[i - 1].role);
}

describe('compactMessages', () => {
  it('is a no-op when there are not more turns than keepLastTurns', async () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      ...turn('call-1'),
    ];
    const provider = new RecordingProvider();
    const registry = new ProviderRegistry();
    registry.register(provider);

    const result = await compactMessages(messages, 2, summarizer, registry);

    expect(result.messages).toBe(messages);
    expect(result.usage).toBeUndefined();
    expect(provider.callCount).toBe(0);
  });

  it('summarizes turns older than keepLastTurns exactly once', async () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      ...turn('call-1'),
      ...turn('call-2'),
      ...turn('call-3'),
    ];
    const provider = new RecordingProvider();
    const registry = new ProviderRegistry();
    registry.register(provider);

    const result = await compactMessages(messages, 1, summarizer, registry);

    expect(provider.callCount).toBe(1);
    // The dropped turn (call-1) went into the summarizer's own request...
    expect(provider.receivedMessages.some(m => m.content.includes('call-1'))).toBe(true);
    // ...and does not survive into the compacted conversation.
    expect(result.messages.some(m => m.content.includes('call-1'))).toBe(false);
    // The system prompt, the task, and the last turn (call-3) survive verbatim.
    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages[1]).toEqual(messages[1]);
    expect(result.messages.some(m => m.content.includes('call-3'))).toBe(true);
    // call-2 fell outside keepLastTurns: 1, so it was summarized away too.
    expect(result.messages.some(m => m.content.includes('call-2'))).toBe(false);
    // One summary turn replaces the dropped turns.
    expect(result.messages.some(m => m.content.includes('Summary: wrote foo.ts once.'))).toBe(true);
    expect(result.usage).toEqual({ prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 });

    // Both the compacted conversation and the summarizer's own request keep strict
    // user/assistant alternation — some providers (Anthropic) reject two consecutive
    // same-role messages outright.
    expect(alternates(result.messages)).toBe(true);
    expect(alternates(provider.receivedMessages)).toBe(true);
  });
});
