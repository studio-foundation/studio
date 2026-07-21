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
});
