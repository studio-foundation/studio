/**
 * Anthropic provider tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Anthropic SDK BEFORE importing the provider
const mockFinalMessage = {
  content: [{ type: 'text', text: 'Hello world' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
};

const mockCreate = vi.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'Hello world' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

const mockStreamFn = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({
    messages: { create: mockCreate, stream: mockStreamFn },
  })),
}));

import { AnthropicProvider } from '../src/providers/anthropic.js';
import type { LLMRequest } from '@studio/contracts';

const baseRequest: LLMRequest = {
  model: 'claude-haiku-4-5',
  messages: [{ role: 'user', content: 'Say hello' }],
};

describe('AnthropicProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls messages.create when no onToken provided', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Hello world' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    const provider = new AnthropicProvider('test-key');
    await provider.call(baseRequest);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockStreamFn).not.toHaveBeenCalled();
  });

  it('calls messages.stream when onToken is provided', async () => {
    const tokens: string[] = [];
    mockStreamFn.mockReturnValueOnce({
      on: vi.fn((event: string, handler: (text: string) => void) => {
        if (event === 'text') {
          handler('Hello');
          handler(' world');
        }
      }),
      finalMessage: vi.fn().mockResolvedValue(mockFinalMessage),
    });

    const provider = new AnthropicProvider('test-key');
    await provider.call(baseRequest, (t) => tokens.push(t));

    expect(mockStreamFn).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(tokens).toEqual(['Hello', ' world']);
  });

  it('returns full LLMResponse with usage when streaming', async () => {
    mockStreamFn.mockReturnValueOnce({
      on: vi.fn((event: string, handler: (text: string) => void) => {
        if (event === 'text') handler('Hello world');
      }),
      finalMessage: vi.fn().mockResolvedValue(mockFinalMessage),
    });

    const provider = new AnthropicProvider('test-key');
    const result = await provider.call(baseRequest, () => {});
    expect(result.content).toBe('Hello world');
    expect(result.usage?.prompt_tokens).toBe(10);
    expect(result.usage?.completion_tokens).toBe(5);
  });
});
