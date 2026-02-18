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
}

export type RalphResult<T> =
  | { status: 'success'; result: T; attempts: number }
  | { status: 'exhausted'; lastResult: T; failures: string[]; attempts: number };

export async function ralph<T>(config: RalphConfig<T>): Promise<RalphResult<T>> {
  const { executor, validator, maxAttempts, retryStrategy, onRetry, onSuccess, onExhausted } = config;

  let attempt = 1;
  const allFailures: string[] = [];

  while (attempt <= maxAttempts) {
    // 1. Execute avec contexte
    const context: ExecutionContext = {
      attempt,
      previousFailures: [...allFailures]
    };

    const result = await executor(context);

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
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    attempt++;
  }

  // Unreachable mais TypeScript est content
  throw new Error('ralph loop should have returned');
}
