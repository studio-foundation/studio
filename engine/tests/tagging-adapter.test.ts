import { describe, it, expect, vi } from 'vitest';
import { createTaggingAdapter, type EngineEvents } from '../src/events.js';

describe('createTaggingAdapter', () => {
  it('forwards each call to the parent handler with the ctx appended', () => {
    const onStageStart = vi.fn();
    const parent: EngineEvents = { onStageStart };
    const adapter = createTaggingAdapter(parent, { depth: 2, childId: 'd2#0' });

    adapter.onStageStart!({ stage_name: 's', stage_index: 0, total_stages: 1, max_attempts: 1 });

    expect(onStageStart).toHaveBeenCalledWith(
      { stage_name: 's', stage_index: 0, total_stages: 1, max_attempts: 1 },
      { depth: 2, childId: 'd2#0' },
    );
  });

  it('exposes only handlers the parent actually defined', () => {
    const parent: EngineEvents = { onStageStart: vi.fn() };
    const adapter = createTaggingAdapter(parent, { depth: 1, childId: 'd1#0' });

    expect(typeof adapter.onStageStart).toBe('function');
    expect(adapter.onStageComplete).toBeUndefined();
  });
});
