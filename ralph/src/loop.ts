// RALPH loop - main function
import type { ValidationResult } from '@studio/contracts';

export interface ExecutionContext {
  attempt: number;
  previousFailures: string[];
}

export interface RetryEvent<T> {
  attempt: number;
  result: T;
  validation: ValidationResult;
  allFailures: string[];
}

export interface RetryStrategy {
  getDelay(attempt: number): number;
}

export interface RalphConfig<T> {
  executor: (context: ExecutionContext) => Promise<T>;
  validator: (result: T) => ValidationResult | Promise<ValidationResult>;
  maxAttempts: number;
  retryStrategy: RetryStrategy;
  onRetry?: (event: RetryEvent<T>) => void | Promise<void>;
  onSuccess?: (result: T, attempts: number) => void | Promise<void>;
  onExhausted?: (lastResult: T, allFailures: string[]) => void | Promise<void>;
  signal?: AbortSignal;
}

export type RalphResult<T> =
  | { status: 'success'; result: T; attempts: number }
  | { status: 'exhausted'; lastResult: T; failures: string[]; attempts: number }
  | { status: 'cancelled'; lastResult?: T; attempts: number };

export async function ralph<T>(config: RalphConfig<T>): Promise<RalphResult<T>> {
  const { executor, validator, maxAttempts, retryStrategy, onRetry, onSuccess, onExhausted, signal } = config;

  let attempt = 1;
  const allFailures: string[] = [];
  let lastResult: T | undefined;

  while (attempt <= maxAttempts) {
    // Check cancellation before each attempt
    if (signal?.aborted) {
      return { status: 'cancelled', lastResult, attempts: attempt };
    }

    // 1. Execute avec contexte
    const context: ExecutionContext = {
      attempt,
      previousFailures: [...allFailures]
    };

    let result: T;
    try {
      result = await executor(context);
    } catch (err) {
      // If signal was aborted, the executor likely threw an AbortError
      if (signal?.aborted) {
        return { status: 'cancelled', lastResult, attempts: attempt };
      }
      throw err; // Re-throw non-abort errors
    }

    lastResult = result;

    // 2. Validate
    const validation = await Promise.resolve(validator(result));

    // 3. Si valide → SUCCESS
    if (validation.valid) {
      await onSuccess?.(result, attempt);
      return { status: 'success', result, attempts: attempt };
    }

    // 4. Si invalide → accumuler erreurs
    allFailures.push(...validation.errors);

    // 5. Si dernière tentative → EXHAUSTED
    if (attempt >= maxAttempts) {
      await onExhausted?.(result, allFailures);
      return { status: 'exhausted', lastResult: result, attempts: attempt, failures: allFailures };
    }

    // Check cancellation before retry
    if (signal?.aborted) {
      return { status: 'cancelled', lastResult: result, attempts: attempt };
    }

    // 6. Callback + delay + retry
    const retryEvent: RetryEvent<T> = {
      attempt,
      result,
      validation,
      allFailures: [...allFailures]
    };
    await onRetry?.(retryEvent);

    const delay = retryStrategy.getDelay(attempt);
    if (delay > 0) {
      await abortableDelay(delay, signal);
    }

    attempt++;
  }

  // Unreachable mais TypeScript est content
  throw new Error('ralph loop should have returned');
}

/** Sleep that resolves immediately if signal is aborted */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
