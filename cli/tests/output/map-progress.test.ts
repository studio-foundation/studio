import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A single shared ora stub. MapRenderer sets `.text` and calls start/stop;
// stopAndPersist is used by the non-live map header path.
const mockOraInstance: Record<string, any> = {
  text: '',
  start: vi.fn().mockReturnThis(),
  stop: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
  stopAndPersist: vi.fn().mockReturnThis(),
};
vi.mock('ora', () => ({ default: vi.fn(() => mockOraInstance) }));

import { ProgressDisplay } from '../../src/output/progress.js';

function mapStart(overrides: Record<string, unknown> = {}) {
  return { map_name: 'generate', total_items: 20, concurrency: 4, ...overrides };
}

describe('ProgressDisplay — fan-out (map) progress', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockOraInstance.text = '';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    logSpy.mockRestore();
  });

  function out(): string {
    return logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  }

  it('prints a header naming the fan-out with item count and concurrency', () => {
    const d = new ProgressDisplay(false, 'live');
    const e = d.getEvents();
    e.onStageStart!({ stage_name: 'generate', stage_index: 1, total_stages: 3, max_attempts: 1 });
    e.onMapStart!(mapStart());
    expect(out()).toContain('fan-out over 20 items (concurrency 4)');
  });

  it('shows advancing done/failed counts and in-flight item labels on the live line', () => {
    const d = new ProgressDisplay(false, 'live');
    const e = d.getEvents();
    e.onStageStart!({ stage_name: 'generate', stage_index: 0, total_stages: 1, max_attempts: 1 });
    e.onMapStart!(mapStart({ total_items: 3, concurrency: 2 }));

    e.onMapItemStart!({ map_name: 'generate', index: 0, total_items: 3, label: 'Napoléon' });
    e.onMapItemStart!({ map_name: 'generate', index: 1, total_items: 3, label: 'Wellington' });
    // Both items are in flight → both names appear on the status line.
    expect(mockOraInstance.text).toContain('Napoléon');
    expect(mockOraInstance.text).toContain('Wellington');
    expect(mockOraInstance.text).toContain('in flight');

    e.onMapItemComplete!({ map_name: 'generate', index: 0, total_items: 3, status: 'success', label: 'Napoléon', run_id: 'run-0' });
    // One done, and the settled item is no longer shown as in flight.
    expect(mockOraInstance.text).toContain('1/3 done');
    expect(mockOraInstance.text).not.toContain('Napoléon');

    e.onMapComplete!({ map_name: 'generate', total: 3, succeeded: 3, failed: 0, status: 'success' });
  });

  it('names a failed item with its child run ID the moment it fails', () => {
    const d = new ProgressDisplay(false, 'live');
    const e = d.getEvents();
    e.onStageStart!({ stage_name: 'generate', stage_index: 0, total_stages: 1, max_attempts: 1 });
    e.onMapStart!(mapStart({ total_items: 2, concurrency: 2 }));

    e.onMapItemStart!({ map_name: 'generate', index: 1, total_items: 2, label: 'Waterloo' });
    e.onMapItemComplete!({
      map_name: 'generate', index: 1, total_items: 2, status: 'failed',
      label: 'Waterloo', run_id: 'child-run-42', error: 'child run child-run-42 failed',
    });

    const printed = out();
    expect(printed).toContain('Waterloo');
    expect(printed).toContain('child-run-42');
    expect(printed).toMatch(/failed/i);
  });

  it('prints a final summary with succeeded/failed counts', () => {
    const d = new ProgressDisplay(false, 'live');
    const e = d.getEvents();
    e.onStageStart!({ stage_name: 'generate', stage_index: 0, total_stages: 1, max_attempts: 1 });
    e.onMapStart!(mapStart({ total_items: 20 }));
    e.onMapComplete!({ map_name: 'generate', total: 20, succeeded: 18, failed: 2, status: 'success' });

    const printed = out();
    expect(printed).toContain('18/20 succeeded');
    expect(printed).toContain('2 failed');
  });

  it('onStageComplete does not print a duplicate generic stage line for a map stage', () => {
    const d = new ProgressDisplay(false, 'live');
    const e = d.getEvents();
    e.onStageStart!({ stage_name: 'generate', stage_index: 0, total_stages: 1, max_attempts: 1 });
    e.onMapStart!(mapStart({ total_items: 1 }));
    e.onMapComplete!({ map_name: 'generate', total: 1, succeeded: 1, failed: 0, status: 'success' });
    logSpy.mockClear();
    e.onStageComplete!({
      stage_name: 'generate', stage_index: 0, total_stages: 1,
      status: 'success', attempts: 1, duration_ms: 1000,
    });
    // The map summary already covered completion — no extra generic "✓" line.
    expect(out()).toBe('');
  });

  it('freezes the stage header line in non-live mode instead of clearing it', () => {
    const d = new ProgressDisplay(false, 'quiet');
    const e = d.getEvents();
    e.onStageStart!({ stage_name: 'generate', stage_index: 0, total_stages: 1, max_attempts: 1 });
    e.onMapStart!(mapStart());
    expect(mockOraInstance.stopAndPersist).toHaveBeenCalled();
    e.onMapComplete!({ map_name: 'generate', total: 20, succeeded: 20, failed: 0, status: 'success' });
  });

  it('is silent in JSON mode', () => {
    const d = new ProgressDisplay(true, 'live');
    const e = d.getEvents();
    e.onStageStart!({ stage_name: 'generate', stage_index: 0, total_stages: 1, max_attempts: 1 });
    e.onMapStart!(mapStart());
    e.onMapItemStart!({ map_name: 'generate', index: 0, total_items: 20, label: 'x' });
    e.onMapItemComplete!({ map_name: 'generate', index: 0, total_items: 20, status: 'failed', label: 'x', run_id: 'r', error: 'boom' });
    e.onMapComplete!({ map_name: 'generate', total: 20, succeeded: 19, failed: 1, status: 'success' });
    expect(out()).toBe('');
  });
});
