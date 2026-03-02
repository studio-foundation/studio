import { describe, it, expect } from 'vitest';
import { raceSignal } from './race-signal.js';

describe('raceSignal', () => {
  it('resolves normally when no signal provided', async () => {
    const result = await raceSignal(Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('resolves normally when signal is not aborted', async () => {
    const controller = new AbortController();
    const result = await raceSignal(Promise.resolve('hello'), controller.signal);
    expect(result).toBe('hello');
  });

  it('rejects immediately if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(raceSignal(new Promise(() => {}), controller.signal))
      .rejects.toThrow('Aborted');
  });

  it('rejects when signal fires after creation', async () => {
    const controller = new AbortController();
    // A promise that never resolves on its own
    const hanging = new Promise<never>(() => {});
    const raced = raceSignal(hanging, controller.signal);
    controller.abort();
    await expect(raced).rejects.toThrow('Aborted');
  });

  it('resolves if promise resolves before signal fires', async () => {
    const controller = new AbortController();
    const result = await raceSignal(Promise.resolve(99), controller.signal);
    // Abort after the fact — should not cause rejection
    controller.abort();
    expect(result).toBe(99);
  });

  it('thrown error name is AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      await raceSignal(new Promise(() => {}), controller.signal);
    } catch (e) {
      expect(e).toBeInstanceOf(DOMException);
      expect((e as DOMException).name).toBe('AbortError');
    }
  });
});
