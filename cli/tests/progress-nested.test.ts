import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressDisplay } from '../src/output/progress.js';

describe('ProgressDisplay — nested child events (STU-620)', () => {
  let logs: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    spy = vi.spyOn(console, 'log').mockImplementation((s?: unknown) => { logs.push(String(s ?? '')); });
  });
  afterEach(() => { spy.mockRestore(); });

  function live() { return new ProgressDisplay(false, { live: true, verbose: false }); }

  it('indents a child stage-start line by its depth', () => {
    const ev = live().getEvents();
    ev.onStageStart!(
      { stage_name: 'child-stage', stage_index: 0, total_stages: 2, max_attempts: 1 },
      { depth: 1, childId: 'd1#0' },
    );
    const line = logs.find(l => l.includes('child-stage'));
    expect(line).toBeDefined();
    expect(line!.startsWith('  ')).toBe(true); // indented once
  });

  it('drops child token + thinking events at depth >= 1', () => {
    const ev = live().getEvents();
    ev.onAgentToken!({ stage: 'child-stage', token: 'x' } as any, { depth: 1, childId: 'd1#0' });
    ev.onAgentThinking!({ stage: 'child-stage', text: 'y' } as any, { depth: 1, childId: 'd1#0' });
    expect(logs.join('')).not.toContain('x');
    expect(logs.join('')).not.toContain('y');
  });

  it('suppresses a depth>=1 stage-start line in non-live mode', () => {
    const display = new ProgressDisplay(false, { live: false, verbose: false });
    const ev = display.getEvents();
    ev.onStageStart!(
      { stage_name: 'child-stage', stage_index: 0, total_stages: 2, max_attempts: 1 },
      { depth: 1, childId: 'd1#0' },
    );
    expect(logs.find(l => l.includes('child-stage'))).toBeUndefined();
  });

  it('does not reprint pipeline banners or mutate runId for child pipeline events', () => {
    const display = live();
    const ev = display.getEvents();

    ev.onPipelineStart!({ pipeline_name: 'parent', run_id: 'parent-1' } as any);
    expect(display.runId).toBe('parent-1');
    logs.length = 0;

    ev.onPipelineStart!({ pipeline_name: 'child', run_id: 'child-1' } as any, { depth: 1, childId: 'd1#0' });
    expect(logs.some(l => l.includes('Running pipeline'))).toBe(false);
    expect(display.runId).toBe('parent-1');

    expect(() =>
      ev.onTaskRetry!(
        { stage: 'child-stage', attempt: 1, max_attempts: 3, failures: ['bad output'] } as any,
        { depth: 1, childId: 'd1#0' },
      )
    ).not.toThrow();
    expect(logs.length).toBe(0);
  });

  it('suppresses depth>=1 stage-start lines while inside a map stage', () => {
    const display = live();
    const ev = display.getEvents();

    ev.onMapStart!({ map_name: 'fan-out', total_items: 2, concurrency: 1 } as any);
    logs.length = 0;

    ev.onStageStart!(
      { stage_name: 'child-stage', stage_index: 0, total_stages: 1, max_attempts: 1 },
      { depth: 1, childId: 'd1#0' },
    );
    expect(logs.find(l => l.includes('child-stage'))).toBeUndefined();
    display.interrupt();
  });

  it('runs a live thinking spinner for a child stage and stops it on completion', () => {
    const display = live();
    const ev = display.getEvents();

    ev.onStageStart!(
      { stage_name: 'child-stage', stage_index: 0, total_stages: 1, max_attempts: 1 },
      { depth: 1, childId: 'd1#0' },
    );
    expect((display as any).thinkingSpinner).toBeTruthy();

    ev.onStageComplete!(
      { stage_name: 'child-stage', stage_index: 0, total_stages: 1, status: 'success', attempts: 1, duration_ms: 5 } as any,
      { depth: 1, childId: 'd1#0' },
    );
    expect((display as any).thinkingSpinner).toBeNull();
    display.interrupt();
  });

  it('does not leave two spinners running when a sibling child stage starts', () => {
    const display = live();
    const ev = display.getEvents();

    ev.onStageStart!(
      { stage_name: 'stage-a', stage_index: 0, total_stages: 2, max_attempts: 1 },
      { depth: 1, childId: 'd1#0' },
    );
    const first = (display as any).thinkingSpinner;
    ev.onStageStart!(
      { stage_name: 'stage-b', stage_index: 1, total_stages: 2, max_attempts: 1 },
      { depth: 1, childId: 'd1#0' },
    );
    const second = (display as any).thinkingSpinner;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first); // prior spinner replaced, not stacked
    expect(first.isSpinning).toBe(false);
    display.interrupt();
  });
});
