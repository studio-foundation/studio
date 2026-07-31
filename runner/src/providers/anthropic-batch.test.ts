import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from './anthropic.js';
import type { LLMRequest } from '@studio-foundation/contracts';

// A scriptable stand-in for client.messages.batches. Every test drives it by
// setting `statuses` (one processing_status per retrieve) and `results`.
const state = {
  created: [] as unknown[],
  statuses: [] as string[],
  results: [] as Array<{ custom_id: string; result: Record<string, unknown> }>,
  cancelled: [] as string[],
  retrieves: 0,
};

const createMock = vi.fn(async (body: unknown) => {
  state.created.push(body);
  return {
    id: 'msgbatch_test',
    processing_status: state.statuses.shift() ?? 'ended',
    request_counts: { succeeded: 0, errored: 0, processing: 0, canceled: 0, expired: 0 },
  };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    messages = {
      batches: {
        create: createMock,
        retrieve: async (id: string) => {
          state.retrieves++;
          return {
            id,
            processing_status: state.statuses.shift() ?? 'ended',
            request_counts: { succeeded: 1, errored: 0, processing: 1, canceled: 0, expired: 0 },
          };
        },
        results: async () => ({
          async *[Symbol.asyncIterator]() {
            for (const entry of state.results) yield entry;
          },
        }),
        cancel: async (id: string) => {
          state.cancelled.push(id);
          return { id };
        },
      },
    };
  },
}));

function message(text: string) {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    model: 'claude-haiku-4-5-20251001',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  };
}

function req(text: string): LLMRequest {
  return { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: text }], max_tokens: 256 };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.created = [];
  state.statuses = [];
  state.results = [];
  state.cancelled = [];
  state.retrieves = 0;
});

describe('AnthropicProvider.submitBatch', () => {
  it('advertises the batch capability', () => {
    const provider = new AnthropicProvider('key');
    expect(typeof provider.submitBatch).toBe('function');
    expect(provider.maxBatchSize).toBe(100_000);
  });

  it('submits one job and matches results back by custom_id, whatever their order', async () => {
    state.results = [
      // Deliberately reversed: the API makes no ordering promise.
      { custom_id: 'b', result: { type: 'succeeded', message: message('second') } },
      { custom_id: 'a', result: { type: 'succeeded', message: message('first') } },
    ];

    const provider = new AnthropicProvider('key');
    const results = await provider.submitBatch([
      { custom_id: 'a', request: req('one') },
      { custom_id: 'b', request: req('two') },
    ]);

    expect(createMock).toHaveBeenCalledTimes(1);
    const body = state.created[0] as { requests: Array<{ custom_id: string; params: Record<string, unknown> }> };
    expect(body.requests.map(r => r.custom_id)).toEqual(['a', 'b']);
    expect(body.requests[0].params).toMatchObject({ model: 'claude-haiku-4-5-20251001', max_tokens: 256 });

    expect(results.map(r => r.custom_id)).toEqual(['a', 'b']);
    expect(results[0].response?.content).toBe('first');
    expect(results[1].response?.content).toBe('second');
  });

  it('reports batch-billed token usage per request', async () => {
    state.results = [{ custom_id: 'a', result: { type: 'succeeded', message: message('hi') } }];
    const provider = new AnthropicProvider('key');
    const [result] = await provider.submitBatch([{ custom_id: 'a', request: req('one') }]);

    // Batched results come back through the same normalization as a live call:
    // the total counts the cache tokens too, and the model that answered is named
    // — a batched fan-out is exactly where a per-model cost breakdown is wanted.
    expect(result.response?.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 20,
      cached_input_tokens: 3,
      cache_creation_tokens: 2,
      by_model: {
        'claude-haiku-4-5-20251001': {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 20,
          cached_input_tokens: 3,
          cache_creation_tokens: 2,
        },
      },
    });
  });

  it('polls until the batch has ended', async () => {
    state.statuses = ['in_progress', 'in_progress', 'ended'];
    state.results = [{ custom_id: 'a', result: { type: 'succeeded', message: message('done') } }];

    const onProgress = vi.fn();
    const provider = new AnthropicProvider('key');
    const results = await provider.submitBatch([{ custom_id: 'a', request: req('one') }], {
      poll_interval_ms: 1,
      onProgress,
    });

    // create returned 'in_progress', then two retrieves ('in_progress', 'ended').
    expect(state.retrieves).toBe(2);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(results[0].response?.content).toBe('done');
  });

  it('reports a per-request failure as an error, not a rejection', async () => {
    state.results = [
      { custom_id: 'ok', result: { type: 'succeeded', message: message('fine') } },
      { custom_id: 'err', result: { type: 'errored', error: { type: 'invalid_request_error' } } },
      { custom_id: 'gone', result: { type: 'expired' } },
      { custom_id: 'stop', result: { type: 'canceled' } },
    ];

    const provider = new AnthropicProvider('key');
    const results = await provider.submitBatch([
      { custom_id: 'ok', request: req('a') },
      { custom_id: 'err', request: req('b') },
      { custom_id: 'gone', request: req('c') },
      { custom_id: 'stop', request: req('d') },
    ]);

    expect(results[0].response).toBeDefined();
    expect(results[1].error).toMatch(/invalid_request_error/);
    expect(results[2].error).toMatch(/expired/);
    expect(results[3].error).toMatch(/canceled/i);
  });

  it('answers for a request the API never reported', async () => {
    state.results = [{ custom_id: 'a', result: { type: 'succeeded', message: message('fine') } }];

    const provider = new AnthropicProvider('key');
    const results = await provider.submitBatch([
      { custom_id: 'a', request: req('a') },
      { custom_id: 'ghost', request: req('b') },
    ]);

    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ custom_id: 'ghost' });
    expect(results[1].error).toMatch(/no result/);
  });

  it('gives up on the wait budget and cancels the batch so it stops billing', async () => {
    state.statuses = ['in_progress', 'in_progress', 'in_progress', 'in_progress'];

    const provider = new AnthropicProvider('key');
    await expect(
      provider.submitBatch([{ custom_id: 'a', request: req('a') }], { poll_interval_ms: 5, max_wait_ms: 1 }),
    ).rejects.toThrow(/did not end within/);

    expect(state.cancelled).toEqual(['msgbatch_test']);
  });

  it('never calls the API for an empty batch', async () => {
    const provider = new AnthropicProvider('key');
    await expect(provider.submitBatch([])).resolves.toEqual([]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses ids the API would reject, before submitting anything', async () => {
    const provider = new AnthropicProvider('key');
    await expect(
      provider.submitBatch([{ custom_id: 'not valid', request: req('a') }]),
    ).rejects.toThrow(/custom_id/);
    expect(createMock).not.toHaveBeenCalled();
  });
});
