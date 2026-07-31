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

  describe('prompt caching', () => {
    /** Run one non-streaming call and hand back the params the SDK was given. */
    async function captureParams(request: Partial<Parameters<AnthropicProvider['call']>[0]>) {
      const client = (provider as unknown as { client: { messages: Record<string, unknown> } }).client;
      let captured: Record<string, unknown> | undefined;
      client.messages.create = (params: Record<string, unknown>) => {
        captured = params;
        return Promise.resolve({
          content: [{ type: 'text', text: '{}' }],
          stop_reason: 'end_turn',
          model: 'claude-haiku-4-20250514',
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      };
      await provider.call({
        model: 'claude-haiku-4-20250514',
        messages: [{ role: 'system', content: 'you are a helpful agent' }, { role: 'user', content: 'hi' }],
        tools: [{ name: 't', description: 'd', parameters: {} }],
        ...request,
      });
      return captured!;
    }

    it('writes no cache on a single-shot call', async () => {
      const params = await captureParams({});

      // The whole point: a call with no successor pays the plain input rate.
      expect(params.system).toEqual([{ type: 'text', text: 'you are a helpful agent' }]);
      expect(JSON.stringify(params.tools)).not.toContain('cache_control');
    });

    it('marks system and the last tool when the caller asks to cache', async () => {
      const params = await captureParams({ cache_prompt: true });

      expect(params.system).toEqual([
        { type: 'text', text: 'you are a helpful agent', cache_control: { type: 'ephemeral' } },
      ]);
      expect((params.tools as Array<Record<string, unknown>>).at(-1)!.cache_control).toEqual({
        type: 'ephemeral',
      });
    });

    it('caches with the default 5m TTL, never the 1h one', async () => {
      const params = await captureParams({ cache_prompt: true });

      // A 1h write costs 2x input and needs three reads to break even; nothing
      // in a pipeline run reuses a prefix that long.
      expect(JSON.stringify(params)).not.toContain('"ttl"');
    });

    it('carries the caller decision into batched requests', async () => {
      const client = (provider as unknown as { client: { messages: Record<string, unknown> } }).client;
      let submitted: Array<{ params: Record<string, unknown> }> | undefined;
      client.messages.batches = {
        create: (body: { requests: Array<{ params: Record<string, unknown> }> }) => {
          submitted = body.requests;
          return Promise.resolve({ id: 'batch_1', processing_status: 'ended', request_counts: {} });
        },
        retrieve: () => Promise.resolve({ id: 'batch_1', processing_status: 'ended', request_counts: {} }),
        results: () => Promise.resolve([]),
        cancel: () => Promise.resolve({}),
      };

      await provider.submitBatch([
        {
          custom_id: 'item_0',
          request: {
            model: 'claude-haiku-4-20250514',
            messages: [{ role: 'system', content: 'stage prompt' }, { role: 'user', content: 'item' }],
          },
        },
      ]);

      // A batch item is the archetypal single-shot call — 50% off a surcharge is
      // still a surcharge.
      expect(JSON.stringify(submitted)).not.toContain('cache_control');
    });
  });
});
