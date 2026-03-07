import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock ora BEFORE importing progress.ts
const mockOraInstance = {
  start: vi.fn().mockReturnThis(),
  stop: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
  text: '',
};
vi.mock('ora', () => ({ default: vi.fn(() => mockOraInstance) }));

import { ProgressDisplay } from '../../src/output/progress.js';

describe('ProgressDisplay — timer utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clearTimer is idempotent (no error if called twice)', () => {
    const d = new ProgressDisplay(false, 'quiet');
    const p = d as unknown as { clearTimer(): void };
    expect(() => {
      p.clearTimer();
      p.clearTimer();
    }).not.toThrow();
  });

  it('startTimer calls updateFn with elapsed seconds after each tick', () => {
    const d = new ProgressDisplay(false, 'quiet');
    const p = d as unknown as {
      resetStageTimer(): void;
      startTimer(fn: (s: string) => void): void;
      clearTimer(): void;
    };
    const calls: string[] = [];
    p.resetStageTimer();
    p.startTimer((s) => calls.push(s));

    vi.advanceTimersByTime(1000);
    expect(calls[0]).toBe('1s');

    vi.advanceTimersByTime(2000);
    expect(calls[2]).toBe('3s');

    p.clearTimer();
  });

  it('clearTimer stops the interval (no more updateFn calls after clear)', () => {
    const d = new ProgressDisplay(false, 'quiet');
    const p = d as unknown as {
      resetStageTimer(): void;
      startTimer(fn: (s: string) => void): void;
      clearTimer(): void;
    };
    const calls: string[] = [];
    p.resetStageTimer();
    p.startTimer((s) => calls.push(s));
    vi.advanceTimersByTime(2000);
    p.clearTimer();
    const countAfterClear = calls.length;
    vi.advanceTimersByTime(5000);
    expect(calls.length).toBe(countAfterClear);
  });

  it('elapsedSeconds returns correct elapsed seconds', () => {
    const d = new ProgressDisplay(false, 'quiet');
    const p = d as unknown as {
      resetStageTimer(): void;
      elapsedSeconds(): number;
    };
    p.resetStageTimer();
    vi.advanceTimersByTime(7500);
    expect(p.elapsedSeconds()).toBe(7);
  });
});
