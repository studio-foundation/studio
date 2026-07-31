// A batch window — the barrier that turns N concurrent single calls into one
// batched submission.
//
// The problem it solves: a fan-out (`map`) stage spawns N independent child
// runs. Each one calls the LLM on its own, so N synchronous HTTP requests leave
// the process at full price. The Batch API bills the same tokens at half that —
// but only for requests that arrive in the same job.
//
// The window is that "same job". Every in-flight item joins it and gets a
// ticket; a ticket's submit() parks the request instead of sending it. The
// window flushes — one submitBatch per provider for everything parked — as soon
// as nothing live can still add to it: every participant is either parked or
// already inside a dispatch, or the batch has hit its size cap. A participant
// that finishes leaves, which lowers the bar for everyone still waiting.
//
// This is what lets the RALPH loop stay exactly as it was. Validation still
// happens per item, inside its own child run, after the batch comes back. An
// item that fails validation retries by calling again — and lands in the *next*
// flush, alongside whichever other items are also retrying. The batches shrink
// round after round without the retry loop knowing batching exists.
//
// Safety net: `flush_after_ms` of quiescence dispatches whatever is parked even
// while a participant is still busy elsewhere (a script stage, a hook, a slow
// tool). Without it, one slow item would hold every other one hostage.

import type { LLMRequest, LLMResponse } from '@studio-foundation/contracts';
import { isAgentLoopProvider, type Provider } from './provider.js';
import { isBatchProvider, type BatchProgress, type BatchProvider } from './batch.js';
import { ProviderRegistry } from './registry.js';

/** Requests per batch before the window dispatches without waiting for the barrier. */
export const DEFAULT_MAX_BATCH_SIZE = 500;
/** Quiescence budget: dispatch what is parked after this long with no new arrival. */
export const DEFAULT_FLUSH_AFTER_MS = 30_000;

export interface BatchDispatchInfo {
  provider: string;
  size: number;
  /** 1-based, per window — batch 1 is the initial fan-out, later ones are retries or overflow. */
  round: number;
}

export interface BatchSettledInfo extends BatchDispatchInfo {
  succeeded: number;
  failed: number;
  duration_ms: number;
}

export interface BatchWindowOptions {
  /** Cap per batch. Bounded by the provider's own `maxBatchSize`. */
  max_size?: number;
  poll_interval_ms?: number;
  max_wait_ms?: number;
  /** 0 disables the quiescence flush (the barrier alone decides). */
  flush_after_ms?: number;
  signal?: AbortSignal;
  onDispatch?: (info: BatchDispatchInfo) => void;
  onProgress?: (progress: BatchProgress) => void;
  onSettled?: (info: BatchSettledInfo) => void;
  /** Called once per provider name that cannot batch, so a caller can say so out loud. */
  onFallback?: (providerName: string) => void;
}

/** One participant's handle on the window. Held for the lifetime of one map item. */
export interface BatchTicket {
  /** Park a request until the window flushes; resolves with that request's response. */
  submit(provider: BatchProvider, request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse>;
  /** This participant will make no further calls. Idempotent. */
  leave(): void;
}

interface Parked {
  custom_id: string;
  provider: BatchProvider;
  request: LLMRequest;
  resolve: (response: LLMResponse) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  detach: () => void;
}

export class BatchWindow {
  private participants = 0;
  private parked: Parked[] = [];
  private dispatching = 0;
  private seq = 0;
  private round = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private fallbacksReported = new Set<string>();

  constructor(private readonly options: BatchWindowOptions = {}) {
    if (options.signal) {
      options.signal.addEventListener('abort', () => this.close(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
    }
  }

  /** Register a participant. Every join() must be matched by a leave(), or the barrier never completes. */
  join(): BatchTicket {
    this.participants++;
    let left = false;
    return {
      submit: (provider, request, signal) => this.submit(provider, request, signal),
      leave: () => {
        if (left) return;
        left = true;
        this.participants--;
        // One fewer participant can still add to the batch — the barrier may now be met.
        this.maybeFlush();
      },
    };
  }

  /** Reject everything still parked and stop accepting new requests. */
  close(reason?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    const error = reason ?? new Error('Batch window closed before this request was dispatched.');
    for (const entry of [...this.parked]) this.settle(entry, undefined, error);
  }

  /** Note that `providerName` cannot batch. Reports through onFallback once per name. */
  noteFallback(providerName: string): void {
    if (this.fallbacksReported.has(providerName)) return;
    this.fallbacksReported.add(providerName);
    this.options.onFallback?.(providerName);
  }

  private submit(provider: BatchProvider, request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    if (this.closed) {
      return Promise.reject(new Error('Batch window is closed; no further requests can be batched.'));
    }
    if (signal?.aborted || this.options.signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    return new Promise<LLMResponse>((resolve, reject) => {
      const entry: Parked = {
        custom_id: `req_${this.seq++}`,
        provider,
        request,
        resolve,
        reject,
        settled: false,
        detach: () => {},
      };
      if (signal) {
        const onAbort = () => this.settle(entry, undefined, new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        entry.detach = () => signal.removeEventListener('abort', onAbort);
      }
      this.parked.push(entry);
      this.maybeFlush();
    });
  }

  private settle(entry: Parked, response?: LLMResponse, error?: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.detach();
    const index = this.parked.indexOf(entry);
    if (index >= 0) this.parked.splice(index, 1);
    if (error !== undefined) entry.reject(error);
    else entry.resolve(response!);
  }

  private capFor(provider: BatchProvider): number {
    const configured = this.options.max_size ?? DEFAULT_MAX_BATCH_SIZE;
    return Math.max(1, Math.min(configured, provider.maxBatchSize));
  }

  /**
   * Dispatch whatever is ready. `force` (the quiescence timer) sends everything
   * parked regardless of who is still busy.
   */
  private maybeFlush(force = false): void {
    if (this.closed) return;

    for (;;) {
      if (this.parked.length === 0) {
        this.clearTimer();
        return;
      }
      // The barrier: nobody live can still add to this batch.
      const barrierMet = force || this.parked.length + this.dispatching >= this.participants;

      const groups = new Map<string, Parked[]>();
      for (const entry of this.parked) {
        const group = groups.get(entry.provider.name);
        if (group) group.push(entry);
        else groups.set(entry.provider.name, [entry]);
      }

      let dispatched = false;
      for (const group of groups.values()) {
        const cap = this.capFor(group[0].provider);
        if (group.length >= cap) {
          this.dispatch(group.slice(0, cap));
          dispatched = true;
        } else if (barrierMet) {
          this.dispatch(group);
          dispatched = true;
        }
      }

      if (!dispatched) {
        this.armTimer();
        return;
      }
      // A group may still be over cap after its first slice — re-evaluate.
    }
  }

  private dispatch(entries: Parked[]): void {
    for (const entry of entries) {
      const index = this.parked.indexOf(entry);
      if (index >= 0) this.parked.splice(index, 1);
    }
    this.clearTimer();

    const provider = entries[0].provider;
    const round = ++this.round;
    const startedAt = Date.now();
    this.dispatching += entries.length;
    this.options.onDispatch?.({ provider: provider.name, size: entries.length, round });

    void provider
      .submitBatch(
        entries.map(entry => ({ custom_id: entry.custom_id, request: entry.request })),
        {
          signal: this.options.signal,
          ...(this.options.poll_interval_ms !== undefined ? { poll_interval_ms: this.options.poll_interval_ms } : {}),
          ...(this.options.max_wait_ms !== undefined ? { max_wait_ms: this.options.max_wait_ms } : {}),
          ...(this.options.onProgress ? { onProgress: this.options.onProgress } : {}),
        }
      )
      .then(results => {
        const byId = new Map(results.map(result => [result.custom_id, result]));
        let succeeded = 0;
        let failed = 0;
        for (const entry of entries) {
          const result = byId.get(entry.custom_id);
          if (result?.response) {
            succeeded++;
            this.settle(entry, result.response);
          } else {
            failed++;
            // A per-request failure is an ordinary executor error: the child
            // run's RALPH loop sees it, enriches, and retries into a later batch.
            this.settle(entry, undefined, new Error(result?.error ?? 'Batch returned no result for this request.'));
          }
        }
        this.options.onSettled?.({
          provider: provider.name,
          size: entries.length,
          round,
          succeeded,
          failed,
          duration_ms: Date.now() - startedAt,
        });
      })
      .catch((err: unknown) => {
        for (const entry of entries) this.settle(entry, undefined, err);
        this.options.onSettled?.({
          provider: provider.name,
          size: entries.length,
          round,
          succeeded: 0,
          failed: entries.length,
          duration_ms: Date.now() - startedAt,
        });
      })
      .finally(() => {
        this.dispatching -= entries.length;
        this.maybeFlush();
      });
  }

  private armTimer(): void {
    const delay = this.options.flush_after_ms ?? DEFAULT_FLUSH_AFTER_MS;
    if (delay <= 0 || this.timer !== null || this.parked.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.maybeFlush(true);
    }, delay);
    // Never keep the process alive just to wait on a batch that nobody is filling.
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * A Provider face over one ticket: `call()` parks the request in the window
 * instead of sending it. Streaming is dropped rather than faked — a batched
 * response arrives whole, so there are no tokens to emit.
 */
class BatchedProvider implements Provider {
  readonly name: string;

  constructor(private readonly base: BatchProvider, private readonly ticket: BatchTicket) {
    this.name = base.name;
  }

  call(request: LLMRequest, _onToken?: (token: string) => void, signal?: AbortSignal): Promise<LLMResponse> {
    return this.ticket.submit(this.base, request, signal);
  }
}

/**
 * A registry that hands out batched providers for the duration of one map item.
 *
 * Everything else passes through untouched: a provider that cannot batch, or
 * one that owns its own agent loop (where there is no single call to intercept),
 * is returned as-is — so `--provider mock` and `--provider claude-code` keep
 * working under a `batch:` map, just without the discount.
 */
export class BatchingProviderRegistry extends ProviderRegistry {
  constructor(
    private readonly base: ProviderRegistry,
    private readonly ticket: BatchTicket,
    private readonly window: BatchWindow,
  ) {
    super();
  }

  override register(provider: Provider): void {
    this.base.register(provider);
  }

  override registerLazy(name: string, factory: () => Provider): void {
    this.base.registerLazy(name, factory);
  }

  override get(name: string): Provider {
    const provider = this.base.get(name);
    if (!isBatchProvider(provider) || isAgentLoopProvider(provider)) {
      this.window.noteFallback(provider.name);
      return provider;
    }
    return new BatchedProvider(provider, this.ticket);
  }

  override has(name: string): boolean {
    return this.base.has(name);
  }

  override list(): string[] {
    return this.base.list();
  }
}
