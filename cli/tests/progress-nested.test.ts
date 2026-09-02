import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressDisplay } from '../src/output/progress.js';
import type { MapStartEvent, MapCompleteEvent, MapItemCompleteEvent } from '@studio-foundation/engine';

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

  // Was 'suppresses a depth>=1 stage-start line in non-live mode' — without it a
  // `call` stage was a single spinner hanging for the whole child run. (STU-861)
  it('prints a depth>=1 stage-start line in non-live mode too', () => {
    const display = new ProgressDisplay(false, { live: false, verbose: false });
    const ev = display.getEvents();
    ev.onStageStart!(
      { stage_name: 'child-stage', stage_index: 0, total_stages: 2, max_attempts: 1 },
      { depth: 1, childId: 'd1#0' },
    );
    expect(logs.find(l => l.includes('child-stage'))).toBeDefined();
    expect((display as unknown as { thinkingSpinner: unknown }).thinkingSpinner).toBeFalsy();
    display.interrupt();
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

  it('does not resurrect a spinner from in-flight child events after interrupt (Ctrl-C)', () => {
    const display = live();
    const ev = display.getEvents();

    ev.onStageStart!(
      { stage_name: 'child-stage', stage_index: 0, total_stages: 2, max_attempts: 1 },
      { depth: 1, childId: 'd1#0' },
    );
    expect((display as any).thinkingSpinner).toBeTruthy();

    display.interrupt();
    expect((display as any).thinkingSpinner).toBeNull();

    // Engine keeps emitting until the abort lands — these must not restart the spinner/timer.
    ev.onStageComplete!(
      { stage_name: 'child-stage', stage_index: 0, total_stages: 2, status: 'success', attempts: 1, duration_ms: 5 } as any,
      { depth: 1, childId: 'd1#0' },
    );
    ev.onStageStart!(
      { stage_name: 'sibling', stage_index: 1, total_stages: 2, max_attempts: 1 },
      { depth: 1, childId: 'd1#0' },
    );
    expect((display as any).thinkingSpinner).toBeNull();
    expect((display as any).timerInterval).toBeNull();
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

describe('ProgressDisplay — a fan-out below the root pipeline (STU-861)', () => {
  let logs: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    spy = vi.spyOn(console, 'log').mockImplementation((s?: unknown) => { logs.push(String(s ?? '')); });
  });
  afterEach(() => { spy.mockRestore(); });

  const display = () => new ProgressDisplay(false, { live: false, verbose: false });
  const at = (depth: number, n = 0) => ({ depth, childId: `d${depth}#${n}` });
  const stack = (d: ProgressDisplay) =>
    (d as unknown as { mapStack: Array<{ key: string; renderer: { suspended: boolean } }> }).mapStack;

  const mapStart = (map_name: string, total_items: number, concurrency = 1): MapStartEvent =>
    ({ map_name, total_items, concurrency });
  const mapDone = (map_name: string, succeeded: number, total: number): MapCompleteEvent =>
    ({ map_name, total, succeeded, failed: 0, status: 'success' });
  const itemDone = (map_name: string, index: number, total_items: number): MapItemCompleteEvent =>
    ({ map_name, index, total_items, status: 'success' });

  it('renders a map reached through a call, which used to print nothing at all', () => {
    const d = display();
    const ev = d.getEvents();

    ev.onMapStart!(mapStart('classify-verdicts', 3, 2), at(1));
    expect(logs.find(l => l.includes('classify-verdicts'))).toBeDefined();

    ev.onMapItemComplete!(itemDone('classify-verdicts', 0, 3), at(1));
    ev.onMapComplete!(mapDone('classify-verdicts', 3, 3), at(1));

    const summary = logs.filter(l => l.includes('3/3 succeeded'));
    expect(summary).toHaveLength(1);
    d.interrupt();
  });

  it('indents a nested fan-out deeper than a root one', () => {
    const root = display();
    root.getEvents().onMapStart!(mapStart('m', 1, 1));
    const rootHeader = logs.find(l => l.includes('↳ m'))!;
    root.interrupt();

    logs.length = 0;
    const nested = display();
    nested.getEvents().onMapStart!(mapStart('m', 1, 1), at(2));
    const nestedHeader = logs.find(l => l.includes('↳ m'))!;
    nested.interrupt();

    const pad = (l: string) => l.length - l.trimStart().length;
    expect(pad(nestedHeader)).toBeGreaterThan(pad(rootHeader));
  });

  it('routes events to the fan-out they came from, not to whichever is newest', () => {
    const d = display();
    const ev = d.getEvents();

    ev.onMapStart!(mapStart('outer', 2, 1), at(1, 0));
    ev.onMapStart!(mapStart('inner', 5, 1), at(2, 0));
    expect(stack(d).map(e => e.key)).toEqual(['1#d1#0', '2#d2#0']);

    // The inner one finishes; the outer must survive and still be addressable.
    ev.onMapComplete!(mapDone('inner', 5, 5), at(2, 0));
    expect(stack(d).map(e => e.key)).toEqual(['1#d1#0']);
    expect(logs.find(l => l.includes('5/2'))).toBeUndefined();  // never credited to 'outer'

    ev.onMapComplete!(mapDone('outer', 2, 2), at(1, 0));
    expect(stack(d)).toHaveLength(0);
    d.interrupt();
  });

  it('keeps two concurrent same-depth fan-outs apart', () => {
    const d = display();
    const ev = d.getEvents();

    ev.onMapStart!(mapStart('a', 1, 1), at(1, 0));
    ev.onMapStart!(mapStart('b', 1, 1), at(1, 1));
    expect(stack(d)).toHaveLength(2);

    ev.onMapComplete!(mapDone('b', 1, 1), at(1, 1));
    expect(stack(d).map(e => e.key)).toEqual(['1#d1#0']);
    d.interrupt();
  });

  it('gives the bottom line to the innermost renderer and hands it back', () => {
    const d = display();
    const ev = d.getEvents();
    const suspended = (i: number) => stack(d)[i].renderer.suspended;

    ev.onMapStart!(mapStart('outer', 2, 1), at(1, 0));
    expect(suspended(0)).toBe(false);

    ev.onMapStart!(mapStart('inner', 5, 1), at(2, 0));
    expect(suspended(0)).toBe(true);   // outer stepped aside
    expect(suspended(1)).toBe(false);

    ev.onMapComplete!(mapDone('inner', 5, 5), at(2, 0));
    expect(suspended(0)).toBe(false);  // outer took it back
    d.interrupt();
  });

  it('collapses nested stage lines inside a fan-out, at any depth', () => {
    const d = display();
    const ev = d.getEvents();

    ev.onMapStart!(mapStart('fan-out', 2, 1), at(1));
    logs.length = 0;
    ev.onStageStart!(
      { stage_name: 'item-stage', stage_index: 0, total_stages: 1, max_attempts: 1 },
      at(2),
    );
    expect(logs.find(l => l.includes('item-stage'))).toBeUndefined();
    d.interrupt();
  });

  it('emits nothing extra in json mode', () => {
    const ev = new ProgressDisplay(true, { live: false, verbose: false }).getEvents();
    ev.onMapStart!(mapStart('m', 1, 1), at(1));
    ev.onMapComplete!(mapDone('m', 1, 1), at(1));
    expect(logs).toHaveLength(0);
  });

  it('drops every live fan-out on interrupt, whatever its depth', () => {
    const d = display();
    const ev = d.getEvents();
    ev.onMapStart!(mapStart('a', 1, 1), at(1, 0));
    ev.onMapStart!(mapStart('b', 1, 1), at(2, 0));
    d.interrupt();
    expect(stack(d)).toHaveLength(0);
  });
});
