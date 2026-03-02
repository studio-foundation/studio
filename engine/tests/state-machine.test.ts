import { describe, it, expect } from 'vitest';
import { isValidTransition, transition } from '../src/state/state-machine.js';

describe('isValidTransition', () => {
  it('pending → running is valid', () => {
    expect(isValidTransition('pending', 'running')).toBe(true);
  });

  it('running → success is valid', () => {
    expect(isValidTransition('running', 'success')).toBe(true);
  });

  it('running → failed is valid', () => {
    expect(isValidTransition('running', 'failed')).toBe(true);
  });

  it('pending → skipped is valid', () => {
    expect(isValidTransition('pending', 'skipped')).toBe(true);
  });

  it('pending → success is INVALID', () => {
    expect(isValidTransition('pending', 'success')).toBe(false);
  });

  it('success → running is INVALID', () => {
    expect(isValidTransition('success', 'running')).toBe(false);
  });

  it('failed → running is INVALID', () => {
    expect(isValidTransition('failed', 'running')).toBe(false);
  });

  it('success → failed is INVALID', () => {
    expect(isValidTransition('success', 'failed')).toBe(false);
  });

  it('pending → failed is INVALID', () => {
    expect(isValidTransition('pending', 'failed')).toBe(false);
  });

  it('running → rejected is valid', () => {
    expect(isValidTransition('running', 'rejected')).toBe(true);
  });

  it('pending → rejected is INVALID', () => {
    expect(isValidTransition('pending', 'rejected')).toBe(false);
  });

  it('rejected → running is INVALID', () => {
    expect(isValidTransition('rejected', 'running')).toBe(false);
  });
});

describe('transition', () => {
  it('pending + start → running', () => {
    expect(transition('pending', 'start')).toBe('running');
  });

  it('running + succeed → success', () => {
    expect(transition('running', 'succeed')).toBe('success');
  });

  it('running + fail → failed', () => {
    expect(transition('running', 'fail')).toBe('failed');
  });

  it('pending + skip → skipped', () => {
    expect(transition('pending', 'skip')).toBe('skipped');
  });

  it('pending + succeed throws', () => {
    expect(() => transition('pending', 'succeed')).toThrow('Invalid state transition');
  });

  it('success + start throws', () => {
    expect(() => transition('success', 'start')).toThrow('Invalid state transition');
  });

  it('failed + succeed throws', () => {
    expect(() => transition('failed', 'succeed')).toThrow('Invalid state transition');
  });

  it('running + reject → rejected', () => {
    expect(transition('running', 'reject')).toBe('rejected');
  });

  it('pending + reject throws', () => {
    expect(() => transition('pending', 'reject')).toThrow('Invalid state transition');
  });

  it('running + cancel → cancelled', () => {
    expect(transition('running', 'cancel')).toBe('cancelled');
  });

  it('pending + cancel throws', () => {
    expect(() => transition('pending', 'cancel')).toThrow('Invalid state transition');
  });
});

describe('isValidTransition (cancel)', () => {
  it('running → cancelled is valid transition', () => {
    expect(isValidTransition('running', 'cancelled')).toBe(true);
  });
});
