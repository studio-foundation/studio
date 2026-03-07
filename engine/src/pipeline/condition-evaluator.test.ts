import { describe, it, expect } from 'vitest';
import { evaluateCondition } from './condition-evaluator.js';

const makeContext = (
  input: Record<string, unknown> | string = {},
  stageOutputs: Map<string, unknown> = new Map(),
) => ({ input, stageOutputs });

describe('evaluateCondition — input namespace', () => {
  it('returns true when input field equals condition value (>=)', () => {
    const ctx = makeContext({ meals_count: 6 });
    expect(evaluateCondition('input.meals_count >= 6', ctx)).toBe(true);
  });

  it('returns false when input field is below threshold', () => {
    const ctx = makeContext({ meals_count: 5 });
    expect(evaluateCondition('input.meals_count >= 6', ctx)).toBe(false);
  });

  it('returns true for strict greater than when value exceeds', () => {
    const ctx = makeContext({ meals_count: 7 });
    expect(evaluateCondition('input.meals_count > 6', ctx)).toBe(true);
  });

  it('returns false for strict greater than when value equals threshold', () => {
    const ctx = makeContext({ meals_count: 6 });
    expect(evaluateCondition('input.meals_count > 6', ctx)).toBe(false);
  });

  it('returns true for less than', () => {
    const ctx = makeContext({ priority: 2 });
    expect(evaluateCondition('input.priority < 3', ctx)).toBe(true);
  });

  it('returns true for less than or equal', () => {
    const ctx = makeContext({ priority: 3 });
    expect(evaluateCondition('input.priority <= 3', ctx)).toBe(true);
  });

  it('returns true for == equality', () => {
    const ctx = makeContext({ mode: 'fast' });
    expect(evaluateCondition("input.mode == fast", ctx)).toBe(true);
  });

  it('returns true for === strict equality with number', () => {
    const ctx = makeContext({ count: 0 });
    expect(evaluateCondition('input.count === 0', ctx)).toBe(true);
  });

  it('returns true for != inequality', () => {
    const ctx = makeContext({ mode: 'slow' });
    expect(evaluateCondition("input.mode != fast", ctx)).toBe(true);
  });

  it('returns true for !== strict inequality', () => {
    const ctx = makeContext({ count: 1 });
    expect(evaluateCondition('input.count !== 0', ctx)).toBe(true);
  });

  it('returns false when input field is missing', () => {
    const ctx = makeContext({ other_field: 5 });
    expect(evaluateCondition('input.meals_count >= 6', ctx)).toBe(false);
  });

  it('returns false when input is a string (not an object)', () => {
    const ctx = makeContext('plain string input');
    expect(evaluateCondition('input.meals_count >= 6', ctx)).toBe(false);
  });

  it('supports nested field paths', () => {
    const ctx = makeContext({ config: { threshold: 10 } });
    expect(evaluateCondition('input.config.threshold > 5', ctx)).toBe(true);
  });
});

describe('evaluateCondition — stages namespace', () => {
  const stageOutputs = new Map<string, unknown>([
    ['entity-extraction', { counts: { OTHER: 3, PERSON: 1 }, total: 4 }],
    ['stage-with-zero', { count: 0 }],
    ['analysis', { score: 0.85 }],
  ]);

  it('returns true when stage output field is above threshold', () => {
    const ctx = makeContext({}, stageOutputs);
    expect(evaluateCondition('stages.entity-extraction.output.counts.OTHER > 0', ctx)).toBe(true);
  });

  it('returns false when stage output field is zero', () => {
    const ctx = makeContext({}, stageOutputs);
    expect(evaluateCondition('stages.stage-with-zero.output.count > 0', ctx)).toBe(false);
  });

  it('supports stage names with hyphens', () => {
    const ctx = makeContext({}, stageOutputs);
    expect(evaluateCondition('stages.entity-extraction.output.total >= 3', ctx)).toBe(true);
  });

  it('returns false when stage does not exist in outputs', () => {
    const ctx = makeContext({}, stageOutputs);
    expect(evaluateCondition('stages.nonexistent.output.count > 0', ctx)).toBe(false);
  });

  it('returns false when nested field path does not exist', () => {
    const ctx = makeContext({}, stageOutputs);
    expect(evaluateCondition('stages.entity-extraction.output.missing.deep > 0', ctx)).toBe(false);
  });

  it('supports float comparisons', () => {
    const ctx = makeContext({}, stageOutputs);
    expect(evaluateCondition('stages.analysis.output.score >= 0.8', ctx)).toBe(true);
  });
});

describe('evaluateCondition — edge cases', () => {
  it('returns false for an unparseable expression (no operator)', () => {
    const ctx = makeContext({ x: 1 });
    expect(evaluateCondition('input.x', ctx)).toBe(false);
  });

  it('handles whitespace around operator', () => {
    const ctx = makeContext({ n: 5 });
    expect(evaluateCondition('input.n   >=   5', ctx)).toBe(true);
  });

  it('>=6 is treated correctly (no space before value)', () => {
    const ctx = makeContext({ n: 6 });
    expect(evaluateCondition('input.n >= 6', ctx)).toBe(true);
  });
});
