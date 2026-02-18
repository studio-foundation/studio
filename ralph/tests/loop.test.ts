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
});
