// End-to-end cover for `map: … batch:` — the fan-out still runs ordinary child
// runs; what changes is that their LLM calls leave as one batched job.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolve } from 'node:path';
import type { LLMRequest, LLMResponse, PipelineDefinition } from '@studio-foundation/contracts';
import {
  ProviderRegistry,
  ToolRegistry,
  type BatchProvider,
  type BatchRequestItem,
  type BatchResultItem,
} from '@studio-foundation/runner';
import { PipelineEngine, type EngineConfig } from '../engine.js';
import { DirectEngineSpawner } from '../spawners/direct-engine-spawner.js';
import type { BatchCompleteEvent, BatchDispatchEvent, EngineEvents, MapStartEvent } from '../events.js';

const FIXTURES_DIR = resolve(__dirname, '__fixtures__/map-batch');

/** Records every batch it is handed, and answers from a per-item script. */
class RecordingBatchProvider implements BatchProvider {
  readonly name = 'fake-batch';
  readonly maxBatchSize = 100;
  readonly batches: BatchRequestItem[][] = [];
  /** item text → how many more times to fail before answering well. */
  failuresLeft = new Map<string, number>();

  async submitBatch(items: BatchRequestItem[]): Promise<BatchResultItem[]> {
    this.batches.push(items);
    return items.map(item => {
      const label = itemLabel(item.request);
      const remaining = this.failuresLeft.get(label) ?? 0;
      if (remaining > 0) {
        this.failuresLeft.set(label, remaining - 1);
        // Contract-invalid output: the child run's RALPH loop retries it, which
        // is what lands it in the next batch.
        return { custom_id: item.custom_id, response: llm('{"wrong_field": true}') };
      }
      return { custom_id: item.custom_id, response: llm(JSON.stringify({ echoed: label })) };
    });
  }

  async call(): Promise<LLMResponse> {
    throw new Error('RecordingBatchProvider: only reachable through submitBatch');
  }
}

/** A provider with no batch endpoint — the fallback path. */
class PlainProvider {
  readonly name = 'fake-batch'; // same name, so the same agent YAML resolves it
  readonly calls: LLMRequest[] = [];

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.calls.push(request);
    return llm(JSON.stringify({ echoed: itemLabel(request) }));
  }
}

function llm(content: string): LLMResponse {
  return {
    content,
    tool_calls: [],
    finish_reason: 'stop',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/** The per-item input is rendered into the prompt as `thing: <item>`; read it back. */
function itemLabel(request: LLMRequest): string {
  const text = request.messages.map(m => m.content).join('\n');
  return text.match(/^thing:\s*(.+)$/m)?.[1].trim() ?? 'unknown';
}

function makeEngine(provider: { name: string }, events?: EngineEvents) {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(provider as never);

  const engineConfig: EngineConfig = {
    configsDir: FIXTURES_DIR,
    providerRegistry,
    toolRegistry: new ToolRegistry(),
  };
  const spawner = new DirectEngineSpawner(engineConfig, events);
  return new PipelineEngine({ ...engineConfig, spawner, maxDepth: 3 }, events);
}

function pipelineWith(batch: unknown, extra: Record<string, unknown> = {}): PipelineDefinition {
  return {
    name: 'fan-out',
    description: 'test',
    version: 1,
    stages: [
      {
        map: 'items',
        over: 'input.things',
        pipeline: 'per-item',
        input: { thing: '{{item}}' },
        ...(batch !== undefined ? { batch } : {}),
        ...extra,
      } as never,
    ],
  };
}

function collectEvents() {
  const mapStarts: MapStartEvent[] = [];
  const dispatches: BatchDispatchEvent[] = [];
  const completes: BatchCompleteEvent[] = [];
  const events: EngineEvents = {
    onMapStart: (e) => { mapStarts.push(e); },
    onBatchDispatch: (e) => { dispatches.push(e); },
    onBatchComplete: (e) => { completes.push(e); },
  };
  return { events, mapStarts, dispatches, completes };
}

describe('map stage — batched dispatch', () => {
  let provider: RecordingBatchProvider;

  beforeEach(() => {
    provider = new RecordingBatchProvider();
  });

  it('sends every item in one batch and returns the same outputs as an unbatched fan-out', async () => {
    const { events, mapStarts, dispatches, completes } = collectEvents();
    const engine = makeEngine(provider, events);

    const result = await engine.run({
      pipelineDef: pipelineWith(true),
      input: { things: ['alpha', 'beta', 'gamma'] },
    });

    expect(result.status).toBe('success');
    const output = result.stages[0]?.output as { total: number; succeeded: number; outputs: unknown[] };
    expect(output).toMatchObject({ total: 3, succeeded: 3, failed: 0 });
    expect(output.outputs).toEqual([
      { echoed: 'alpha' },
      { echoed: 'beta' },
      { echoed: 'gamma' },
    ]);

    // One batch, three requests — not three batches of one.
    expect(provider.batches).toHaveLength(1);
    expect(provider.batches[0]).toHaveLength(3);

    expect(mapStarts[0]).toMatchObject({ batch: true, concurrency: 3 });
    expect(dispatches).toEqual([{ map_name: 'items', provider: 'fake-batch', size: 3, round: 1 }]);
    expect(completes[0]).toMatchObject({ size: 3, succeeded: 3, failed: 0 });
  });

  it('retries a failed item into the next batch, so rounds shrink', async () => {
    // beta's first answer breaks its contract; its retry must ride a second
    // batch rather than a full-price single call.
    provider.failuresLeft.set('beta', 1);
    const { events, dispatches } = collectEvents();
    const engine = makeEngine(provider, events);

    const result = await engine.run({
      pipelineDef: pipelineWith(true),
      input: { things: ['alpha', 'beta', 'gamma'] },
    });

    expect(result.status).toBe('success');
    expect(provider.batches.map(b => b.length)).toEqual([3, 1]);
    expect(dispatches.map(d => d.size)).toEqual([3, 1]);
    const output = result.stages[0]?.output as { succeeded: number; outputs: unknown[] };
    expect(output.succeeded).toBe(3);
    expect(output.outputs).toContainEqual({ echoed: 'beta' });
  });

  it('splits at batch.max_size', async () => {
    const engine = makeEngine(provider);

    const result = await engine.run({
      pipelineDef: pipelineWith({ max_size: 2 }),
      input: { things: ['a', 'b', 'c', 'd', 'e'] },
    });

    expect(result.status).toBe('success');
    // Concurrency defaults to min(items, max_size) = 2, so items go two at a time.
    expect(provider.batches.every(b => b.length <= 2)).toBe(true);
    expect(provider.batches.flat()).toHaveLength(5);
  });

  it('caps the batch at an explicit concurrency', async () => {
    const engine = makeEngine(provider);

    const result = await engine.run({
      pipelineDef: pipelineWith(true, { concurrency: 2 }),
      input: { things: ['a', 'b', 'c', 'd'] },
    });

    expect(result.status).toBe('success');
    expect(provider.batches.every(b => b.length <= 2)).toBe(true);
  });

  it('fails only the item whose batched request errored', async () => {
    const erroring: BatchProvider = {
      name: 'fake-batch',
      maxBatchSize: 100,
      call: async () => { throw new Error('unused'); },
      submitBatch: async (items) =>
        items.map(item => {
          const label = itemLabel(item.request);
          return label === 'beta'
            ? { custom_id: item.custom_id, error: 'invalid_request_error: too long' }
            : { custom_id: item.custom_id, response: llm(JSON.stringify({ echoed: label })) };
        }),
    };
    const engine = makeEngine(erroring);

    const result = await engine.run({
      pipelineDef: pipelineWith(true, { on_item_failure: 'collect-all' }),
      input: { things: ['alpha', 'beta', 'gamma'] },
    });

    const output = result.stages[0]?.output as {
      succeeded: number;
      failed: number;
      results: Array<{ index: number; status: string }>;
    };
    expect(output).toMatchObject({ total: 3, succeeded: 2, failed: 1 });
    expect(output.results[1].status).toBe('failed');
  });

  it('runs the fan-out unbatched — and unchanged — on a provider with no batch endpoint', async () => {
    const plain = new PlainProvider();
    const { events, mapStarts, dispatches } = collectEvents();
    const engine = makeEngine(plain, events);

    const result = await engine.run({
      pipelineDef: pipelineWith(true),
      input: { things: ['alpha', 'beta'] },
    });

    expect(result.status).toBe('success');
    expect(plain.calls).toHaveLength(2);   // ordinary single calls
    expect(dispatches).toHaveLength(0);    // nothing was ever batched
    expect(mapStarts[0]).toMatchObject({ batch: true });
  });

  it('keeps a provider with no batch endpoint at one child run at a time when concurrency is unset (STU-2100)', async () => {
    let inFlight = 0;
    let peak = 0;
    const plain = new PlainProvider();
    const call = plain.call.bind(plain);
    plain.call = async (request) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return call(request);
    };
    const { events, mapStarts } = collectEvents();
    const engine = makeEngine(plain, events);

    await engine.run({
      pipelineDef: pipelineWith(true),
      input: { things: Array.from({ length: 10 }, (_, i) => `t${i}`) },
    });

    expect(mapStarts[0]).toMatchObject({ batch: true, concurrency: 1 });
    expect(peak).toBe(1);
  });

  it('batches all items together on a batch-capable provider when concurrency is unset (STU-2100)', async () => {
    const { events, dispatches } = collectEvents();
    const engine = makeEngine(provider, events);

    await engine.run({
      pipelineDef: pipelineWith(true),
      input: { things: Array.from({ length: 10 }, (_, i) => `t${i}`) },
    });

    expect(dispatches.map((d) => d.size)).toEqual([10]);
  });

  it('warns once when a batch-capable provider is paired with a concurrency below the item count (STU-2100)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const engine = makeEngine(provider);
      await engine.run({
        pipelineDef: pipelineWith(true, { concurrency: 4 }),
        input: { things: Array.from({ length: 10 }, (_, i) => `t${i}`) },
      });
      const caps = warn.mock.calls.filter((c) => String(c[0]).includes('caps each batch at 4'));
      expect(caps).toHaveLength(1);
      expect(String(caps[0][0])).toContain('[map:items]');
      expect(String(caps[0][0])).toContain('10 items');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn about the cap when concurrency covers every item', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const engine = makeEngine(provider);
      await engine.run({
        pipelineDef: pipelineWith(true, { concurrency: 4 }),
        input: { things: ['a', 'b', 'c', 'd'] },
      });
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('caps each batch'))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves an unbatched map stage sequential by default', async () => {
    const { events, mapStarts } = collectEvents();
    const engine = makeEngine(provider, events);

    await engine.run({
      pipelineDef: pipelineWith(undefined),
      input: { things: ['a', 'b', 'c'] },
    });

    expect(mapStarts[0].concurrency).toBe(1);
    expect(mapStarts[0].batch).toBeUndefined();
    // Sequential items each hit the barrier alone — still correct, one per batch.
    expect(provider.batches).toHaveLength(0);
  });

  it('treats batch: false as off', async () => {
    const { events, mapStarts } = collectEvents();
    const engine = makeEngine(provider, events);

    await engine.run({
      pipelineDef: pipelineWith(false),
      input: { things: ['a', 'b'] },
    });

    expect(mapStarts[0]).toMatchObject({ concurrency: 1 });
    expect(mapStarts[0].batch).toBeUndefined();
  });
});
