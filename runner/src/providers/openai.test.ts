import { describe, it, expect, vi } from 'vitest';
import { OpenAIProvider } from './openai.js';

// Fake async iterable that yields chunks with a delay between each,
// simulating a slow stream that should be interruptible.
async function* slowStream(chunks: unknown[], delayMs = 10): AsyncGenerator<unknown> {
  for (const chunk of chunks) {
    await new Promise((r) => setTimeout(r, delayMs));
    yield chunk;
  }
}

vi.mock('openai', () => {
  return {
    default: class FakeOpenAI {
      chat = {
        completions: {
          create: (_params: unknown, _opts: { signal?: AbortSignal }) =>
            slowStream([
              { choices: [{ delta: { content: 'hello' }, finish_reason: null }] },
              { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] },
            ]),
        },
      };
    },
  };
});

describe('OpenAIProvider', () => {
  it('aborts streaming when signal fires mid-iteration', async () => {
    const provider = new OpenAIProvider('test-key');
    const controller = new AbortController();
    const onToken = vi.fn();

    const callPromise = provider.call(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      },
      onToken,
      controller.signal,
    );

    // Abort after first chunk has a chance to arrive
    setTimeout(() => controller.abort(), 5);

    await expect(callPromise).rejects.toSatisfy(
      (e: unknown) => e instanceof DOMException && (e as DOMException).name === 'AbortError',
    );
  });

  it('completes normally when signal is not aborted', async () => {
    const provider = new OpenAIProvider('test-key');
    const onToken = vi.fn();

    const result = await provider.call(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      },
      onToken,
    );

    expect(result.content).toBe('hello world');
    expect(onToken).toHaveBeenCalledTimes(2);
  });
});
