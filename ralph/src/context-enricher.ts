// Enrich context between retries
import type { ExecutionContext, RetryEvent } from './loop.js';

export function buildRetryContext<T>(event: RetryEvent<T>): ExecutionContext {
  return {
    attempt: event.attempt + 1,
    previousFailures: event.allFailures
  };
}
