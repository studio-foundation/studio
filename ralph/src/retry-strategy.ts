// Retry strategies
import type { RetryStrategy } from './loop.js';

export function noDelay(): RetryStrategy {
  return {
    getDelay: () => 0,
  };
}

export function fixedDelay(ms: number): RetryStrategy {
  return {
    getDelay: () => ms,
  };
}

export function exponentialBackoff(baseMs: number, maxMs: number): RetryStrategy {
  return {
    getDelay: (attempt: number) => {
      const delay = baseMs * Math.pow(2, attempt - 1);
      return Math.min(delay, maxMs);
    },
  };
}
