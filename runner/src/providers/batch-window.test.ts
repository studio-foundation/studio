import { describe, it, expect, vi } from 'vitest';
import type { LLMRequest, LLMResponse } from '@studio-foundation/contracts';
import type { BatchDispatchOptions, BatchProvider, BatchRequestItem, BatchResultItem } from './batch.js';
import { isBatchProvider, assertValidBatch } from './batch.js';
import { BatchWindow, BatchingProviderRegistry } from './batch-window.js';
import { ProviderRegistry } from './registry.js';
import type { AgentLoopProvider, AgentLoopResult, Provider, ToolCallOutcome } from './provider.js';

/**
 * A batch provider whose dispatches are settled by the test, so the barrier can
 * be observed without any timing assumptions.
 */
class FakeBatchProvider implements BatchProvider {
  readonly name = 'fake-batch';
  readonly calls: BatchRequestItem[][] = [];
  private pending: Array<(results: BatchResultItem[]) => void> = [];

  constructor(readonly maxBatchSize = 100, private readonly autoRespond = true) {}

  async submitBatch(items: BatchRequestItem[], _options?: BatchDispatchOptions): Promise<BatchResultItem[]> {
    this.calls.push(items);
    if (this.autoRespond) {
      return items.map(item => ({ custom_id: item.custom_id, response: echo(item.request) }));
    }
    return new Promise<BatchResultItem[]>(resolve => {
      this.pending.push(resolve);
    });
  }

  /** Settle the Nth outstanding dispatch with successes. */
  settle(index = 0, results?: BatchResultItem[]): void {
    const resolve = this.pending[index];
    const items = this.calls[index];
    resolve(results ?? items.map(item => ({ custom_id: item.custom_id, response: echo(item.request) })));
  }

  async call(): Promise<LLMResponse> {
    throw new Error('FakeBatchProvider: batched calls only');
  }
}

function echo(request: LLMRequest): LLMResponse {
  return {
    content: JSON.stringify({ echoed: request.messages.at(-1)?.content ?? '' }),
    tool_calls: [],
    finish_reason: 'stop',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function req(text: string): LLMRequest {
  return { model: 'test-model', messages: [{ role: 'user', content: text }] };
}

/** Let queued microtasks (and any pending timers set to 0) drain. */
const tick = () => new Promise(resolve => setImmediate(resolve));

describe('BatchWindow — the barrier', () => {
  it('holds requests until every participant has parked, then sends one batch', async () => {
    const provider = new FakeBatchProvider(100, false);
    const window = new BatchWindow({ flush_after_ms: 0 });
    const tickets = [window.join(), window.join(), window.join()];

    const first = tickets[0].submit(provider, req('a'));
    await tick();
    expect(provider.calls).toHaveLength(0); // two participants have not parked yet

    const second = tickets[1].submit(provider, req('b'));
    await tick();
    expect(provider.calls).toHaveLength(0);

    const third = tickets[2].submit(provider, req('c'));
    await tick();
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toHaveLength(3);

    provider.settle(0);
    const responses = await Promise.all([first, second, third]);
    expect(responses.map(r => JSON.parse(r.content).echoed)).toEqual(['a', 'b', 'c']);
  });

  it('dispatches without the stragglers once they leave', async () => {
    const provider = new FakeBatchProvider(100, false);
    const window = new BatchWindow({ flush_after_ms: 0 });
    const [parked, leaver] = [window.join(), window.join()];

    const pending = parked.submit(provider, req('a'));
    await tick();
    expect(provider.calls).toHaveLength(0);

    // The second item finished (cache hit, failure, no LLM call) — it will
    // never park, so the batch must not keep waiting for it.
    leaver.leave();
    await tick();
    expect(provider.calls).toHaveLength(1);

    provider.settle(0);
    await expect(pending).resolves.toMatchObject({ finish_reason: 'stop' });
  });

  it('splits at max_size instead of waiting for the barrier', async () => {
    const provider = new FakeBatchProvider(100, false);
    const window = new BatchWindow({ max_size: 2, flush_after_ms: 0 });
    const tickets = [window.join(), window.join(), window.join(), window.join()];

    const pending = [
      tickets[0].submit(provider, req('a')),
      tickets[1].submit(provider, req('b')),
    ];
    await tick();
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toHaveLength(2);

    pending.push(tickets[2].submit(provider, req('c')), tickets[3].submit(provider, req('d')));
    await tick();
    expect(provider.calls).toHaveLength(2);

    provider.settle(0);
    provider.settle(1);
    await expect(Promise.all(pending)).resolves.toHaveLength(4);
  });

  it('honours the provider ceiling over a larger configured max_size', async () => {
    const provider = new FakeBatchProvider(2, false);
    const window = new BatchWindow({ max_size: 1000, flush_after_ms: 0 });
    const tickets = [window.join(), window.join(), window.join()];
    const pending = tickets.map((ticket, i) => ticket.submit(provider, req(`item-${i}`)));

    await tick();
    // 3 parked, provider caps at 2 → one full batch out, the remainder follows
    // on the barrier (all three are parked, none are busy).
    expect(provider.calls[0]).toHaveLength(2);
    expect(provider.calls[1]).toHaveLength(1);

    provider.settle(0);
    provider.settle(1);
    await expect(Promise.all(pending)).resolves.toHaveLength(3);
  });

  it('flushes on quiescence when a participant is busy elsewhere', async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeBatchProvider(100, false);
      const window = new BatchWindow({ flush_after_ms: 1000 });
      const [parked] = [window.join(), window.join()]; // second never parks

      const pending = parked.submit(provider, req('a'));
      expect(provider.calls).toHaveLength(0);

      vi.advanceTimersByTime(1000);
      expect(provider.calls).toHaveLength(1);

      provider.settle(0);
      vi.useRealTimers();
      await expect(pending).resolves.toMatchObject({ finish_reason: 'stop' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects only the request that errored, leaving its peers intact', async () => {
    const provider = new FakeBatchProvider(100, false);
    const window = new BatchWindow({ flush_after_ms: 0 });
    const tickets = [window.join(), window.join()];
    const good = tickets[0].submit(provider, req('good'));
    const bad = tickets[1].submit(provider, req('bad'));
    await tick();

    const [goodId, badId] = provider.calls[0].map(item => item.custom_id);
    provider.settle(0, [
      { custom_id: goodId, response: echo(req('good')) },
      { custom_id: badId, error: 'overloaded_error' },
    ]);

    await expect(good).resolves.toMatchObject({ finish_reason: 'stop' });
    // A per-request failure surfaces as an ordinary executor error, which is
    // what lets the child run's RALPH loop retry it into the next batch.
    await expect(bad).rejects.toThrow('overloaded_error');
  });

  it('fails every request of a batch the provider refused', async () => {
    const provider: BatchProvider = {
      name: 'refuser',
      maxBatchSize: 10,
      call: async () => { throw new Error('unused'); },
      submitBatch: async () => { throw new Error('batch submission refused'); },
    };
    const window = new BatchWindow({ flush_after_ms: 0 });
    const tickets = [window.join(), window.join()];
    const pending = tickets.map(t => t.submit(provider, req('x')));

    await expect(Promise.allSettled(pending)).resolves.toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ]);
  });

  it('reports each dispatch and its outcome', async () => {
    const provider = new FakeBatchProvider();
    const onDispatch = vi.fn();
    const onSettled = vi.fn();
    const window = new BatchWindow({ flush_after_ms: 0, onDispatch, onSettled });
    const ticket = window.join();

    await ticket.submit(provider, req('a'));

    expect(onDispatch).toHaveBeenCalledWith({ provider: 'fake-batch', size: 1, round: 1 });
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'fake-batch', size: 1, round: 1, succeeded: 1, failed: 0 }),
    );
  });

  it('groups a mixed window by provider — one batch each', async () => {
    const alpha = new FakeBatchProvider(100, false);
    const beta = new FakeBatchProvider(100, false);
    Object.defineProperty(beta, 'name', { value: 'other-batch' });

    const window = new BatchWindow({ flush_after_ms: 0 });
    const tickets = [window.join(), window.join()];
    const pending = [tickets[0].submit(alpha, req('a')), tickets[1].submit(beta, req('b'))];
    await tick();

    expect(alpha.calls).toHaveLength(1);
    expect(beta.calls).toHaveLength(1);

    alpha.settle(0);
    beta.settle(0);
    await expect(Promise.all(pending)).resolves.toHaveLength(2);
  });

  it('rejects what is still parked when the window closes', async () => {
    const provider = new FakeBatchProvider(100, false);
    const window = new BatchWindow({ flush_after_ms: 0 });
    window.join(); // a participant that never parks holds the barrier
    const ticket = window.join();

    const pending = ticket.submit(provider, req('a'));
    await tick();
    expect(provider.calls).toHaveLength(0);

    window.close();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it('aborts parked requests when the run is cancelled', async () => {
    const provider = new FakeBatchProvider(100, false);
    const controller = new AbortController();
    const window = new BatchWindow({ flush_after_ms: 0, signal: controller.signal });
    window.join();
    const ticket = window.join();

    const pending = ticket.submit(provider, req('a'));
    await tick();
    controller.abort();

    await expect(pending).rejects.toThrow();
  });
});

describe('BatchingProviderRegistry', () => {
  it('batches a provider that can, and passes through one that cannot', async () => {
    const batchable = new FakeBatchProvider();
    const plain: Provider = {
      name: 'plain',
      call: async () => echo(req('direct')),
    };
    const base = new ProviderRegistry();
    base.register(batchable);
    base.register(plain);

    const onFallback = vi.fn();
    const window = new BatchWindow({ flush_after_ms: 0, onFallback });
    const registry = new BatchingProviderRegistry(base, window.join(), window);

    // Same name, so agent YAML and config never have to know about batching.
    const wrapped = registry.get('fake-batch');
    expect(wrapped.name).toBe('fake-batch');
    expect(wrapped).not.toBe(batchable);
    await wrapped.call(req('a'));
    expect(batchable.calls).toHaveLength(1);

    expect(registry.get('plain')).toBe(plain);
    expect(onFallback).toHaveBeenCalledWith('plain');
  });

  it('leaves a provider that owns its own agent loop alone', () => {
    // There is no single call to intercept in a provider-owned loop, so it must
    // run unbatched rather than silently losing its tool turns.
    const loopProvider: AgentLoopProvider & BatchProvider = {
      name: 'looping',
      maxBatchSize: 10,
      call: async () => echo(req('x')),
      submitBatch: async (items: BatchRequestItem[]) =>
        items.map(item => ({ custom_id: item.custom_id, response: echo(item.request) })),
      runAgentLoop: async (
        _r: LLMRequest,
        _e: (n: string, a: Record<string, unknown>, id: string) => Promise<ToolCallOutcome>,
      ): Promise<AgentLoopResult> => ({ content: '{}', tool_calls: [], finish_reason: 'stop' }),
    };
    const base = new ProviderRegistry();
    base.register(loopProvider);

    const window = new BatchWindow({ flush_after_ms: 0 });
    const registry = new BatchingProviderRegistry(base, window.join(), window);
    expect(registry.get('looping')).toBe(loopProvider);
  });

  it('delegates has()/list() to the registry it wraps', () => {
    const base = new ProviderRegistry();
    base.register(new FakeBatchProvider());
    const window = new BatchWindow({ flush_after_ms: 0 });
    const registry = new BatchingProviderRegistry(base, window.join(), window);

    expect(registry.has('fake-batch')).toBe(true);
    expect(registry.has('nope')).toBe(false);
    expect(registry.list()).toEqual(['fake-batch']);
  });
});

describe('batch capability helpers', () => {
  it('detects a batch provider by its submitBatch method', () => {
    expect(isBatchProvider(new FakeBatchProvider())).toBe(true);
    expect(isBatchProvider({ name: 'plain', call: async () => echo(req('x')) })).toBe(false);
  });

  it('rejects custom_ids the API would reject', () => {
    expect(() => assertValidBatch([{ custom_id: 'ok_1', request: req('a') }])).not.toThrow();
    expect(() => assertValidBatch([{ custom_id: 'has space', request: req('a') }])).toThrow(/custom_id/);
    expect(() => assertValidBatch([{ custom_id: '', request: req('a') }])).toThrow(/custom_id/);
    expect(() =>
      assertValidBatch([
        { custom_id: 'dup', request: req('a') },
        { custom_id: 'dup', request: req('b') },
      ]),
    ).toThrow(/Duplicate/);
  });
});
