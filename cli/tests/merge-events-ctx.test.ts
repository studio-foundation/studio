import { describe, it, expect, vi } from 'vitest';
import { mergeEvents } from '../src/commands/run.js';

describe('mergeEvents forwards ctx to progress (STU-620)', () => {
  it('threads ctx through onStageStart and onToolCallComplete', () => {
    const onStageStart = vi.fn();
    const onToolCallComplete = vi.fn();
    const progress = { onStageStart, onToolCallComplete } as any;
    const merged = mergeEvents(progress, { log: () => {} } as any, 'p', {});
    const ctx = { depth: 2, childId: 'd2#0' };

    merged.onStageStart!({ stage_name: 's', stage_index: 0, total_stages: 1, max_attempts: 1 } as any, ctx);
    merged.onToolCallComplete!({ stage: 's', tool: 't', result: 'r' } as any, ctx);

    expect(onStageStart).toHaveBeenCalledWith(expect.anything(), ctx);
    expect(onToolCallComplete).toHaveBeenCalledWith(expect.anything(), ctx);
  });
});
