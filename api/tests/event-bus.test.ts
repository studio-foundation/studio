import { describe, it, expect } from 'vitest';
import { RunEventBus } from '../src/event-bus.js';

describe('RunEventBus', () => {
  it('delivers events to subscribers', () => {
    const bus = new RunEventBus();
    const received: unknown[] = [];
    bus.subscribe('run-1', (e) => received.push(e));
    bus.emit('run-1', 'stage_complete', { stage: 'brief-analysis' });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'stage_complete', data: { stage: 'brief-analysis' } });
  });

  it('unsubscribe stops delivery', () => {
    const bus = new RunEventBus();
    const received: unknown[] = [];
    const unsub = bus.subscribe('run-1', (e) => received.push(e));
    unsub();
    bus.emit('run-1', 'stage_complete', {});
    expect(received).toHaveLength(0);
  });

  it('close emits done then cleans up', () => {
    const bus = new RunEventBus();
    const types: string[] = [];
    bus.subscribe('run-1', (e) => types.push(e.type));
    bus.close('run-1');
    expect(types).toEqual(['done']);
    // After close, no more events
    bus.emit('run-1', 'stage_complete', {});
    expect(types).toHaveLength(1);
  });

  it('isolates events between runs', () => {
    const bus = new RunEventBus();
    const run1: unknown[] = [];
    const run2: unknown[] = [];
    bus.subscribe('run-1', (e) => run1.push(e));
    bus.subscribe('run-2', (e) => run2.push(e));
    bus.emit('run-1', 'stage_complete', {});
    expect(run1).toHaveLength(1);
    expect(run2).toHaveLength(0);
  });

  it('supports multiple subscribers on same run', () => {
    const bus = new RunEventBus();
    let count = 0;
    bus.subscribe('run-1', () => count++);
    bus.subscribe('run-1', () => count++);
    bus.emit('run-1', 'pipeline_complete', {});
    expect(count).toBe(2);
  });
});
