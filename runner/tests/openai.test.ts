import { describe, it, expect, vi, beforeEach } from 'vitest';

// Helper: build a text chunk
function textChunk(content: string) {
  return { choices: [{ delta: { content, tool_calls: undefined }, finish_reason: null }], usage: null };
}
// Helper: build a stop chunk with usage
function stopChunk(usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) {
  return { choices: [{ delta: {}, finish_reason: 'stop' }], usage };
}
// Helper: async generator
async function* makeStream(chunks: object[]) {
  for (const c of chunks) yield c;
}

const mockCreate = vi.fn();

vi.mock('openai', () => ({
  default: vi.fn(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

import { OpenAIProvider } from '../src/providers/openai.js';
import type { LLMRequest } from '@studio/contracts';

const baseRequest: LLMRequest = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Say hello' }],
};

describe('OpenAIProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses non-streaming create when no onToken provided', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Hello', tool_calls: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const provider = new OpenAIProvider('test-key');
    await provider.call(baseRequest);
    expect(mockCreate).toHaveBeenCalledWith(expect.not.objectContaining({ stream: true }), expect.anything());
  });

  it('uses streaming create when onToken is provided', async () => {
    mockCreate.mockReturnValueOnce(makeStream([
      textChunk('Hello'),
      textChunk(' world'),
      stopChunk(),
    ]));
    const provider = new OpenAIProvider('test-key');
    const tokens: string[] = [];
    await provider.call(baseRequest, (t) => tokens.push(t));
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ stream: true }), expect.anything());
    expect(tokens).toEqual(['Hello', ' world']);
  });

  it('accumulates content and returns correct LLMResponse when streaming', async () => {
    mockCreate.mockReturnValueOnce(makeStream([
      textChunk('Hello'),
      textChunk(' world'),
      stopChunk({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
    ]));
    const provider = new OpenAIProvider('test-key');
    const result = await provider.call(baseRequest, () => {});
    expect(result.content).toBe('Hello world');
    expect(result.finish_reason).toBe('stop');
    expect(result.usage?.prompt_tokens).toBe(10);
  });
});
