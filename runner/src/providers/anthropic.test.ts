import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from './anthropic.js';

// We mock the entire SDK so no real HTTP calls are made.
// The fake stream hangs on finalMessage() to simulate the bug scenario.
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class FakeAnthropic {
      messages = {
        stream: (_params: unknown, _opts: unknown) => {
          const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
          return {
            on(event: string, handler: (...args: unknown[]) => void) {
              if (!listeners.has(event)) listeners.set(event, []);
              listeners.get(event)!.push(handler);
              return this;
            },
            // finalMessage() hangs forever — this is the bug we're fixing
            finalMessage: () => new Promise(() => {}),
          };
        },
        create: (_params: unknown, _opts: unknown) => new Promise(() => {}),
      };
    },
  };
});

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider('test-key');
  });

  it('aborts streaming call when signal fires', async () => {
    const controller = new AbortController();
    const onToken = vi.fn();

    const callPromise = provider.call(
      {
        model: 'claude-haiku-4-20250514',
        messages: [{ role: 'user', content: 'hello' }],
      },
      onToken,
      controller.signal,
    );

    // Fire signal after a tick to let the stream start
    await Promise.resolve();
    controller.abort();

    await expect(callPromise).rejects.toSatisfy(
      (e: unknown) => e instanceof DOMException && (e as DOMException).name === 'AbortError',
    );
  });

  it('aborts non-streaming call when signal fires', async () => {
    const controller = new AbortController();

    const callPromise = provider.call(
      {
        model: 'claude-haiku-4-20250514',
        messages: [{ role: 'user', content: 'hello' }],
      },
      undefined,
      controller.signal,
    );

    await Promise.resolve();
    controller.abort();

    await expect(callPromise).rejects.toSatisfy(
      (e: unknown) => e instanceof DOMException && (e as DOMException).name === 'AbortError',
    );
  });

  it('resolves normally when signal is not aborted', async () => {
    // Directly override stream on the already-created client instance.
    // (prototype override won't work because messages is an instance property.)
    const client = (provider as unknown as { client: { messages: Record<string, unknown> } }).client;
    client.messages.stream = () => ({
      on: (_: string, __: unknown) => ({}),
      finalMessage: () => Promise.resolve({
        content: [{ type: 'text', text: '{"ok":true}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });

    const controller = new AbortController();
    const result = await provider.call(
      {
        model: 'claude-haiku-4-20250514',
        messages: [{ role: 'user', content: 'hello' }],
      },
      vi.fn(),
      controller.signal,
    );
    expect(result).toBeDefined();
  });
});
