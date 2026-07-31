/**
 * Anthropic provider implementation with full tool calling support
 */

import type { LLMRequest, LLMResponse } from '@studio-foundation/contracts';
import { withModel } from '@studio-foundation/contracts';
import type { Provider } from './provider.js';
import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  MessageParam,
  Tool,
  TextBlockParam
} from '@anthropic-ai/sdk/resources/messages';
import { raceSignal } from '../utils/race-signal.js';
import {
  assertValidBatch,
  type BatchDispatchOptions,
  type BatchProvider,
  type BatchRequestItem,
  type BatchResultItem,
} from './batch.js';

/** Hard ceiling of the Message Batches API: 100k requests (or 256 MB) per batch. */
const ANTHROPIC_MAX_BATCH_SIZE = 100_000;
/** How often to ask whether a batch has ended. Batches typically end in well under an hour. */
const DEFAULT_POLL_INTERVAL_MS = 15_000;
/** The API expires a batch after 24h; waiting past that buys nothing. */
const DEFAULT_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class AnthropicProvider implements Provider, BatchProvider {
  readonly name = 'anthropic';
  readonly maxBatchSize = ANTHROPIC_MAX_BATCH_SIZE;
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY
    });
  }

  async call(request: LLMRequest, onToken?: (token: string) => void, signal?: AbortSignal): Promise<LLMResponse> {
    const params = this.buildParams(request);

    if (onToken) {
      // Streaming path
      const stream = this.client.messages.stream(params, { signal });
      stream.on('text', (textDelta: string) => {
        if (signal?.aborted) return; // guard: don't emit after abort
        onToken(textDelta);
      });
      // KEY FIX: race finalMessage() against signal abort.
      // Without this, finalMessage() hangs forever when the HTTP connection
      // is killed mid-stream (the stream 'end' event never fires).
      const response = await raceSignal(stream.finalMessage(), signal);
      return this.parseResponse(response);
    }

    // Non-streaming path
    const response = await raceSignal(this.client.messages.create(params, { signal }), signal);
    return this.parseResponse(response);
  }

  /**
   * Message Batches API: submit every request as one job, poll until it ends,
   * then collect the results by `custom_id`.
   *
   * Every token in a batch is billed at 50% of the synchronous rate, which is
   * the whole reason this path exists — see the `batch:` option on a map stage
   * for what decides which calls arrive here together.
   *
   * A request that failed on its own comes back with `error` set. The promise
   * rejects only if the batch as a whole failed; on abort or wait-budget
   * exhaustion the batch is cancelled best-effort so it stops billing.
   */
  async submitBatch(items: BatchRequestItem[], options: BatchDispatchOptions = {}): Promise<BatchResultItem[]> {
    if (items.length === 0) return [];
    if (items.length > this.maxBatchSize) {
      throw new Error(
        `Batch of ${items.length} requests exceeds the Anthropic limit of ${this.maxBatchSize}.`
      );
    }
    assertValidBatch(items);

    const { signal, onProgress } = options;
    const pollIntervalMs = options.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS;
    const maxWaitMs = options.max_wait_ms ?? DEFAULT_MAX_WAIT_MS;
    const startedAt = Date.now();

    const created = await raceSignal(
      this.client.messages.batches.create(
        {
          requests: items.map(item => ({
            custom_id: item.custom_id,
            params: this.buildParams(item.request),
          })),
        },
        { signal }
      ),
      signal
    );

    try {
      let batch = created;
      while (batch.processing_status !== 'ended') {
        const elapsed = Date.now() - startedAt;
        if (elapsed > maxWaitMs) {
          throw new Error(
            `Anthropic batch ${batch.id} did not end within ${Math.round(maxWaitMs / 1000)}s ` +
            `(${batch.request_counts.processing} of ${items.length} requests still processing).`
          );
        }
        await sleep(pollIntervalMs, signal);
        batch = await raceSignal(this.client.messages.batches.retrieve(created.id, { signal }), signal);
        onProgress?.({
          batch_id: batch.id,
          status: batch.processing_status,
          total: items.length,
          succeeded: batch.request_counts.succeeded,
          errored: batch.request_counts.errored,
          processing: batch.request_counts.processing,
          elapsed_ms: Date.now() - startedAt,
        });
      }

      const collected = new Map<string, BatchResultItem>();
      const results = await raceSignal(this.client.messages.batches.results(created.id, { signal }), signal);
      for await (const entry of results) {
        collected.set(entry.custom_id, this.parseBatchEntry(entry.custom_id, entry.result));
      }

      // Answer for every request that went in, even one the API never reported.
      return items.map(item =>
        collected.get(item.custom_id) ?? {
          custom_id: item.custom_id,
          error: `Anthropic batch ${created.id} returned no result for this request.`,
        }
      );
    } catch (err) {
      // An abandoned batch keeps running (and billing) unless it is cancelled.
      await this.client.messages.batches.cancel(created.id).catch(() => {});
      throw err;
    }
  }

  private parseBatchEntry(
    customId: string,
    result: { type: string; message?: Message; error?: unknown }
  ): BatchResultItem {
    switch (result.type) {
      case 'succeeded':
        return { custom_id: customId, response: this.parseResponse(result.message as Message) };
      case 'errored':
        return { custom_id: customId, error: `Anthropic batch request errored: ${JSON.stringify(result.error)}` };
      case 'canceled':
        return { custom_id: customId, error: 'Anthropic batch request was canceled before it ran.' };
      case 'expired':
        return { custom_id: customId, error: 'Anthropic batch request expired (the batch exceeded its 24h window).' };
      default:
        return { custom_id: customId, error: `Anthropic batch request ended with unknown result type "${result.type}".` };
    }
  }

  private buildParams(request: LLMRequest) {
    // Extract system messages (Anthropic handles them separately)
    const systemMessages = request.messages.filter(m => m.role === 'system');
    const systemContent = systemMessages.map(m => m.content).join('\n\n');

    // Convert remaining messages to Anthropic format
    const anthropicMessages: MessageParam[] = request.messages
      .filter(m => m.role !== 'system')
      .map(msg => {
        if (msg.role === 'user') {
          return { role: 'user' as const, content: msg.content };
        }
        if (msg.role === 'assistant') {
          return { role: 'assistant' as const, content: msg.content };
        }
        throw new Error(`Unsupported message role: ${msg.role}`);
      });

    // Only the caller knows whether a second turn will read this prefix back, and
    // a write it never reads costs more than not caching at all — so the marker
    // goes on only when asked for. Default TTL (5 minutes) is deliberate: the 1h
    // TTL doubles the write premium and needs three reads, not two, to break even.
    const cacheControl = request.cache_prompt
      ? { cache_control: { type: 'ephemeral' as const } }
      : {};

    // Convert tool definitions to Anthropic format.
    // The prefix renders tools → system, so marking the last tool and the system
    // block caches them as one span.
    const rawTools = request.tools ?? [];
    const tools: Tool[] | undefined = rawTools.length > 0
      ? rawTools.map((tool, index) => ({
          name: tool.name,
          description: tool.description,
          input_schema: {
            type: 'object',
            ...tool.parameters
          } as Tool['input_schema'],
          ...(index === rawTools.length - 1 ? cacheControl : {})
        }))
      : undefined;

    const systemParam: TextBlockParam[] | undefined = systemContent
      ? [{ type: 'text', text: systemContent, ...cacheControl }]
      : undefined;

    return {
      model: request.model,
      max_tokens: request.max_tokens || 4096,
      system: systemParam,
      messages: anthropicMessages,
      tools: tools,
      temperature: request.temperature
    };
  }

  private parseResponse(response: Message): LLMResponse {
    // Parse tool calls and text content from response
    const tool_calls: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }> = [];
    let textContent = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        tool_calls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>
        });
      }
    }

    const cachedInputTokens = response.usage.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = response.usage.cache_creation_input_tokens ?? 0;

    return {
      content: textContent,
      tool_calls,
      finish_reason: response.stop_reason || 'stop',
      // Attributed to the model the API answered with, not the one requested —
      // an alias like `claude-sonnet-4-5` resolves to a dated id, and the cost
      // breakdown has to name what was actually billed.
      usage: withModel(response.model, {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens:
          response.usage.input_tokens + response.usage.output_tokens + cachedInputTokens + cacheCreationTokens,
        ...(cachedInputTokens > 0 ? { cached_input_tokens: cachedInputTokens } : {}),
        ...(cacheCreationTokens > 0 ? { cache_creation_tokens: cacheCreationTokens } : {}),
      })
    };
  }
}
