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

// Helper functions for non-live tests
function makeQuietDisplay() {
  return new ProgressDisplay(false, 'quiet');
}

function stageStartEvent(n = 1, total = 3) {
  return { stage_name: 'entity-extraction', stage_index: n - 1, total_stages: total, max_attempts: 3 };
}

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

describe('ProgressDisplay — timer in non-live mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates spinner text with elapsed seconds every second', () => {
    const d = makeQuietDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());

    vi.advanceTimersByTime(5000);

    expect(mockOraInstance.text).toContain('5s');
  });

  it('clears timer on onStageComplete', () => {
    const d = makeQuietDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    vi.advanceTimersByTime(3000);

    events.onStageComplete!({
      stage_name: 'entity-extraction', stage_index: 0, total_stages: 3,
      status: 'success', attempts: 1, duration_ms: 3000,
    });

    const textAfterComplete = mockOraInstance.text;
    vi.advanceTimersByTime(5000);
    expect(mockOraInstance.text).toBe(textAfterComplete);
  });

  it('clears timer on onTaskRetry', () => {
    const d = makeQuietDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    vi.advanceTimersByTime(2000);

    events.onTaskRetry!({ stage: 'entity-extraction', attempt: 2, max_attempts: 3, failures: ['missing field'] });

    const textAfterRetry = mockOraInstance.text;
    vi.advanceTimersByTime(5000);
    expect(mockOraInstance.text).toBe(textAfterRetry);
  });

  it('clears timer on interrupt()', () => {
    const d = makeQuietDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    vi.advanceTimersByTime(2000);

    d.interrupt();

    const textAfterInterrupt = mockOraInstance.text;
    vi.advanceTimersByTime(5000);
    expect(mockOraInstance.text).toBe(textAfterInterrupt);
  });
});
