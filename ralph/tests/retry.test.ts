import { describe, it, expect } from 'vitest';
import { noDelay, fixedDelay, exponentialBackoff } from '../src/retry-strategy.js';

describe('noDelay', () => {
  it('always returns 0', () => {
    const strategy = noDelay();
    expect(strategy.getDelay(1)).toBe(0);
    expect(strategy.getDelay(2)).toBe(0);
    expect(strategy.getDelay(100)).toBe(0);
  });

  it('returns 0 for all attempts', () => {
    const strategy = noDelay();
    for (let i = 1; i <= 10; i++) {
      expect(strategy.getDelay(i)).toBe(0);
    }
  });
});

describe('fixedDelay', () => {
  it('always returns same delay', () => {
    const strategy = fixedDelay(1000);
    expect(strategy.getDelay(1)).toBe(1000);
    expect(strategy.getDelay(2)).toBe(1000);
    expect(strategy.getDelay(5)).toBe(1000);
    expect(strategy.getDelay(100)).toBe(1000);
  });

  it('works with different delay values', () => {
    expect(fixedDelay(500).getDelay(1)).toBe(500);
    expect(fixedDelay(2000).getDelay(1)).toBe(2000);
    expect(fixedDelay(100).getDelay(1)).toBe(100);
  });

  it('works with zero delay', () => {
    const strategy = fixedDelay(0);
    expect(strategy.getDelay(1)).toBe(0);
  });
});

describe('exponentialBackoff', () => {
  it('doubles each attempt', () => {
    const strategy = exponentialBackoff(1000, 10000);
    expect(strategy.getDelay(1)).toBe(1000);  // 1000 * 2^0
    expect(strategy.getDelay(2)).toBe(2000);  // 1000 * 2^1
    expect(strategy.getDelay(3)).toBe(4000);  // 1000 * 2^2
    expect(strategy.getDelay(4)).toBe(8000);  // 1000 * 2^3
  });

  it('caps at maxMs', () => {
    const strategy = exponentialBackoff(1000, 5000);
    expect(strategy.getDelay(1)).toBe(1000);
    expect(strategy.getDelay(2)).toBe(2000);
    expect(strategy.getDelay(3)).toBe(4000);
    expect(strategy.getDelay(4)).toBe(5000); // Would be 8000 but capped
    expect(strategy.getDelay(5)).toBe(5000); // Would be 16000 but capped
    expect(strategy.getDelay(10)).toBe(5000); // Would be 512000 but capped
  });

  it('works with different base values', () => {
    const strategy = exponentialBackoff(100, 10000);
    expect(strategy.getDelay(1)).toBe(100);
    expect(strategy.getDelay(2)).toBe(200);
    expect(strategy.getDelay(3)).toBe(400);
    expect(strategy.getDelay(4)).toBe(800);
  });

  it('respects max from the start if base > max', () => {
    const strategy = exponentialBackoff(10000, 5000);
    expect(strategy.getDelay(1)).toBe(5000); // 10000 capped to 5000
  });

  it('handles large attempt numbers without overflow', () => {
    const strategy = exponentialBackoff(1000, 60000);
    const delay = strategy.getDelay(100);
    expect(delay).toBe(60000); // Should be capped, not Infinity
    expect(delay).toBeLessThanOrEqual(60000);
  });

  it('works with small max values', () => {
    const strategy = exponentialBackoff(10, 50);
    expect(strategy.getDelay(1)).toBe(10);
    expect(strategy.getDelay(2)).toBe(20);
    expect(strategy.getDelay(3)).toBe(40);
    expect(strategy.getDelay(4)).toBe(50); // Capped
  });
});
