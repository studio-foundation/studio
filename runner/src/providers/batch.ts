// Batch dispatch — one asynchronous submission for N independent LLM calls.
//
// A provider that implements this can take a set of requests, hand them to its
// vendor's batch endpoint as a single job, and return the responses keyed by the
// caller's `custom_id`. The point is price, not latency: Anthropic's Message
// Batches API bills every token — input, output, cache write, cache read — at
// 50% of the synchronous rate, and it is allowed up to 24h to finish.
//
// Nothing here knows about map stages or pipelines. It is a provider
// capability, discovered with isBatchProvider() and consumed by the coalescing
// layer in batch-window.ts, which is the piece that decides *which* calls
// belong in the same batch.

import type { LLMRequest, LLMResponse } from '@studio-foundation/contracts';
import type { Provider } from './provider.js';

/** One request in a batch, tagged with a caller-owned id. */
export interface BatchRequestItem {
  /**
   * Echoed back on the matching result. Must be unique within the batch and
   * match `^[a-zA-Z0-9_-]{1,64}$` — the Anthropic API rejects anything else.
   */
  custom_id: string;
  request: LLMRequest;
}

/** One result, matched to its request by `custom_id`. Exactly one of the two optional fields is set. */
export interface BatchResultItem {
  custom_id: string;
  response?: LLMResponse;
  /** The provider's reason this single request did not produce a response. */
  error?: string;
}

/** Emitted on each poll so a caller can show that a long batch is still alive. */
export interface BatchProgress {
  batch_id: string;
  status: string;
  total: number;
  succeeded: number;
  errored: number;
  processing: number;
  elapsed_ms: number;
}

export interface BatchDispatchOptions {
  signal?: AbortSignal;
  /** How often to ask whether the batch has ended. */
  poll_interval_ms?: number;
  /** Give up on the whole batch after this long. */
  max_wait_ms?: number;
  onProgress?: (progress: BatchProgress) => void;
}

export interface BatchProvider extends Provider {
  /** Largest number of requests this provider accepts in one batch. */
  readonly maxBatchSize: number;
  /**
   * Submit every request as one batch and resolve once the batch has ended.
   *
   * Returns one result per input `custom_id`, in no guaranteed order. A request
   * that failed on its own (validation, overloaded, expired) comes back with
   * `error` set — it does not reject the call. The promise rejects only when the
   * batch as a whole failed: submission refused, the wait budget ran out, or the
   * caller aborted.
   */
  submitBatch(items: BatchRequestItem[], options?: BatchDispatchOptions): Promise<BatchResultItem[]>;
}

export function isBatchProvider(provider: Provider): provider is BatchProvider {
  return typeof (provider as BatchProvider).submitBatch === 'function';
}

/** Anthropic's `custom_id` grammar. Enforced before submission so a bad id fails here, not in the API. */
export const CUSTOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function assertValidBatch(items: BatchRequestItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!CUSTOM_ID_PATTERN.test(item.custom_id)) {
      throw new Error(
        `Invalid batch custom_id "${item.custom_id}": must be 1-64 characters of [a-zA-Z0-9_-].`
      );
    }
    if (seen.has(item.custom_id)) {
      throw new Error(`Duplicate batch custom_id "${item.custom_id}": ids must be unique within a batch.`);
    }
    seen.add(item.custom_id);
  }
}
