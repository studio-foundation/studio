import { describe, it, expect, vi } from 'vitest';
import { ralph, type ExecutionContext } from '../src/loop.js';
import { noDelay } from '../src/retry-strategy.js';

describe('ralph loop', () => {
  it('returns success on first attempt when valid', async () => {
    const executor = vi.fn().mockResolvedValue('result');
    const validator = vi.fn().mockReturnValue({ valid: true, errors: [], warnings: [] });

    const result = await ralph({
      executor,
      validator,
      maxAttempts: 3,
      retryStrategy: noDelay()
    });

    expect(result.status).toBe('success');
    expect(result.attempts).toBe(1);
    expect(executor).toHaveBeenCalledTimes(1);
    if (result.status === 'success') {
      expect(result.result).toBe('result');
    }
  });

  it('retries and succeeds on second attempt', async () => {
    const validator = vi.fn()
      .mockReturnValueOnce({ valid: false, errors: ['fail 1'], warnings: [] })
      .mockReturnValueOnce({ valid: true, errors: [], warnings: [] });

    const result = await ralph({
      executor: async () => 'result',
      validator,
      maxAttempts: 3,
      retryStrategy: noDelay()
    });

    expect(result.status).toBe('success');
    expect(result.attempts).toBe(2);
    expect(validator).toHaveBeenCalledTimes(2);
  });

  it('returns exhausted after max attempts', async () => {
    const validator = vi.fn().mockReturnValue({
      valid: false,
      errors: ['always fails'],
      warnings: []
    });

    const result = await ralph({
      executor: async () => 'result',
      validator,
      maxAttempts: 3,
      retryStrategy: noDelay()
    });

    expect(result.status).toBe('exhausted');
    expect(result.attempts).toBe(3);
    if (result.status === 'exhausted') {
      expect(result.failures).toHaveLength(3);
      expect(result.failures).toEqual(['always fails', 'always fails', 'always fails']);
    }
  });

  it('passes execution context with previousFailures', async () => {
    const executorCalls: ExecutionContext[] = [];

    const executor = vi.fn(async (ctx: ExecutionContext) => {
      executorCalls.push({ ...ctx });
      return 'result';
    });

    const validator = vi.fn()
      .mockReturnValueOnce({ valid: false, errors: ['error 1'], warnings: [] })
      .mockReturnValueOnce({ valid: false, errors: ['error 2'], warnings: [] })
      .mockReturnValueOnce({ valid: true, errors: [], warnings: [] });

    await ralph({
      executor,
      validator,
      maxAttempts: 5,
      retryStrategy: noDelay()
    });

    // First call: no previous failures
    expect(executorCalls[0]).toEqual({ attempt: 1, previousFailures: [] });

    // Second call: has first error
    expect(executorCalls[1]).toEqual({ attempt: 2, previousFailures: ['error 1'] });

    // Third call: has both errors
    expect(executorCalls[2]).toEqual({ attempt: 3, previousFailures: ['error 1', 'error 2'] });
  });

  it('calls onRetry callback on each retry', async () => {
    const onRetry = vi.fn();
    const validator = vi.fn()
      .mockReturnValueOnce({ valid: false, errors: ['fail'], warnings: [] })
      .mockReturnValueOnce({ valid: true, errors: [], warnings: [] });

    await ralph({
      executor: async () => 'result',
      validator,
      maxAttempts: 3,
      retryStrategy: noDelay(),
      onRetry
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toMatchObject({
      attempt: 1,
      result: 'result',
      validation: { valid: false, errors: ['fail'], warnings: [] },
      allFailures: ['fail']
    });
  });

  it('calls onSuccess on successful completion', async () => {
    const onSuccess = vi.fn();

    await ralph({
      executor: async () => 'result',
      validator: () => ({ valid: true, errors: [], warnings: [] }),
      maxAttempts: 3,
      retryStrategy: noDelay(),
      onSuccess
    });

    expect(onSuccess).toHaveBeenCalledWith('result', 1);
  });

  it('calls onExhausted when max attempts reached', async () => {
    const onExhausted = vi.fn();

    await ralph({
      executor: async () => 'result',
      validator: () => ({ valid: false, errors: ['fail'], warnings: [] }),
      maxAttempts: 2,
      retryStrategy: noDelay(),
      onExhausted
    });

    expect(onExhausted).toHaveBeenCalledWith('result', ['fail', 'fail']);
  });

  it('does not call onRetry on last failed attempt', async () => {
    const onRetry = vi.fn();

    await ralph({
      executor: async () => 'result',
      validator: () => ({ valid: false, errors: ['fail'], warnings: [] }),
      maxAttempts: 2,
      retryStrategy: noDelay(),
      onRetry
    });

    // Should only retry once (between attempt 1 and 2)
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('accumulates errors from multiple validation failures', async () => {
    const validator = vi.fn()
      .mockReturnValueOnce({ valid: false, errors: ['error A', 'error B'], warnings: [] })
      .mockReturnValueOnce({ valid: false, errors: ['error C'], warnings: [] });

    const result = await ralph({
      executor: async () => 'result',
      validator,
      maxAttempts: 2,
      retryStrategy: noDelay()
    });

    if (result.status === 'exhausted') {
      expect(result.failures).toEqual(['error A', 'error B', 'error C']);
    }
  });

  it('supports async validators', async () => {
    const validator = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return { valid: true, errors: [], warnings: [] };
    });

    const result = await ralph({
      executor: async () => 'result',
      validator,
      maxAttempts: 3,
      retryStrategy: noDelay()
    });

    expect(result.status).toBe('success');
  });

  it('supports async callbacks', async () => {
    const onRetry = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
    });

    const validator = vi.fn()
      .mockReturnValueOnce({ valid: false, errors: ['fail'], warnings: [] })
      .mockReturnValueOnce({ valid: true, errors: [], warnings: [] });

    await ralph({
      executor: async () => 'result',
      validator,
      maxAttempts: 3,
      retryStrategy: noDelay(),
      onRetry
    });

    expect(onRetry).toHaveBeenCalled();
  });

  it('returns cancelled immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const executor = vi.fn().mockResolvedValue('result');
    const validator = vi.fn().mockReturnValue({ valid: true, errors: [], warnings: [] });

    const result = await ralph({
      executor,
      validator,
      maxAttempts: 3,
      retryStrategy: noDelay(),
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(executor).not.toHaveBeenCalled();
  });

  it('returns cancelled when signal aborts between attempts', async () => {
    const controller = new AbortController();

    const executor = vi.fn().mockResolvedValue('result');
    const validator = vi.fn().mockReturnValueOnce({ valid: false, errors: ['fail'], warnings: [] });

    // Abort after first validation
    validator.mockImplementationOnce(() => {
      controller.abort();
      return { valid: false, errors: ['fail 2'], warnings: [] };
    });

    const result = await ralph({
      executor,
      validator,
      maxAttempts: 5,
      retryStrategy: noDelay(),
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('returns cancelled when executor throws AbortError', async () => {
    const controller = new AbortController();

    const executor = vi.fn().mockImplementation(async () => {
      controller.abort();
      const err = new DOMException('The operation was aborted', 'AbortError');
      throw err;
    });
    const validator = vi.fn();

    const result = await ralph({
      executor,
      validator,
      maxAttempts: 3,
      retryStrategy: noDelay(),
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(validator).not.toHaveBeenCalled();
  });

  it('cancellation resolves pending retry delay immediately', async () => {
    const controller = new AbortController();

    let attempt = 0;
    const executor = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        // After first attempt, schedule abort in 5ms (well before any real delay)
        setTimeout(() => controller.abort(), 5);
      }
      return 'result';
    });
    const validator = vi.fn().mockReturnValue({ valid: false, errors: ['fail'], warnings: [] });

    const start = Date.now();
    const result = await ralph({
      executor,
      validator,
      maxAttempts: 5,
      retryStrategy: { getDelay: () => 60_000 }, // 60 second delay — should NOT wait
      signal: controller.signal,
    });

    const elapsed = Date.now() - start;
    expect(result.status).toBe('cancelled');
    expect(elapsed).toBeLessThan(5000); // Way less than 60s
  });

  it('works with object result type (generic T)', async () => {
    type Output = { value: number; label: string };

    const result = await ralph<Output>({
      executor: async () => ({ value: 42, label: 'ok' }),
      validator: () => ({ valid: true, errors: [], warnings: [] }),
      maxAttempts: 3,
      retryStrategy: noDelay()
    });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.value).toBe(42);
      expect(result.result.label).toBe('ok');
    }
  });

  it('exhausts immediately with maxAttempts=1 on first failure', async () => {
    const validator = vi.fn().mockReturnValue({
      valid: false,
      errors: ['always fails'],
      warnings: []
    });

    const result = await ralph({
      executor: async () => 'result',
      validator,
      maxAttempts: 1,
      retryStrategy: noDelay()
    });

    expect(result.status).toBe('exhausted');
    expect(result.attempts).toBe(1);
    if (result.status === 'exhausted') {
      expect(result.failures).toEqual(['always fails']);
    }
    expect(validator).toHaveBeenCalledTimes(1);
  });

  it('stops immediately without retrying when isFatal returns true', async () => {
    const executor = vi.fn().mockResolvedValue({ error: 'ImportError at startup' });
    const validator = vi.fn().mockReturnValue({ valid: false, errors: ['ImportError at startup'], warnings: [] });
    const onRetry = vi.fn();
    const onExhausted = vi.fn();

    const result = await ralph<{ error?: string }>({
      executor,
      validator,
      maxAttempts: 3,
      retryStrategy: noDelay(),
      isFatal: (r) => r.error != null,
      onRetry,
      onExhausted,
    });

    expect(result.status).toBe('exhausted');
    expect(result.attempts).toBe(1);
    // A deterministic crash must not burn the remaining attempts.
    expect(executor).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(onExhausted).toHaveBeenCalledWith({ error: 'ImportError at startup' }, ['ImportError at startup']);
    if (result.status === 'exhausted') {
      expect(result.failures).toEqual(['ImportError at startup']);
    }
  });

  it('keeps retrying when isFatal returns false for a recoverable failure', async () => {
    const validator = vi.fn()
      .mockReturnValueOnce({ valid: false, errors: ['transient'], warnings: [] })
      .mockReturnValueOnce({ valid: true, errors: [], warnings: [] });

    const result = await ralph<{ error?: string }>({
      executor: async () => ({}),
      validator,
      maxAttempts: 3,
      retryStrategy: noDelay(),
      isFatal: (r) => r.error != null, // no .error → not fatal → retry allowed
    });

    expect(result.status).toBe('success');
    expect(result.attempts).toBe(2);
  });

  it('never consults isFatal on a valid result', async () => {
    const isFatal = vi.fn().mockReturnValue(true);

    const result = await ralph({
      executor: async () => 'result',
      validator: () => ({ valid: true, errors: [], warnings: [] }),
      maxAttempts: 3,
      retryStrategy: noDelay(),
      isFatal,
    });

    expect(result.status).toBe('success');
    expect(isFatal).not.toHaveBeenCalled();
  });

  it('propagates executor exceptions that are not abort errors', async () => {
    const error = new Error('unexpected failure');

    await expect(ralph({
      executor: async () => { throw error; },
      validator: () => ({ valid: true, errors: [], warnings: [] }),
      maxAttempts: 3,
      retryStrategy: noDelay()
    })).rejects.toThrow('unexpected failure');
  });
});
