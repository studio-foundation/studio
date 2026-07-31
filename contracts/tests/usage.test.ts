import { describe, it, expect } from 'vitest';
import {
  accumulateTokenUsage,
  emptyTokenUsage,
  sumTokenUsage,
  withModel,
  type TokenUsage,
} from '../src/usage.js';

describe('withModel', () => {
  it('attributes counts to the model that produced them', () => {
    expect(withModel('claude-sonnet-4-5', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      by_model: { 'claude-sonnet-4-5': { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    });
  });

  it('leaves the split off when the model is unknown', () => {
    const usage = withModel(undefined, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(usage.by_model).toBeUndefined();
  });

  it('does not alias the callers counts object', () => {
    const counts = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const usage = withModel('m', counts);
    counts.prompt_tokens = 999;
    expect(usage.prompt_tokens).toBe(10);
    expect(usage.by_model!.m.prompt_tokens).toBe(10);
  });
});

describe('accumulateTokenUsage', () => {
  it('sums totals and cache counts', () => {
    const target = emptyTokenUsage();
    accumulateTokenUsage(target, {
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 40,
      cached_input_tokens: 20, cache_creation_tokens: 5,
    });
    accumulateTokenUsage(target, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });

    expect(target).toEqual({
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 43,
      cached_input_tokens: 20,
      cache_creation_tokens: 5,
    });
  });

  it('merges the per-model split instead of overwriting it', () => {
    const target = emptyTokenUsage();
    accumulateTokenUsage(target, withModel('opus', { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }));
    accumulateTokenUsage(target, withModel('opus', { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 }));
    accumulateTokenUsage(target, withModel('haiku', { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }));

    expect(target.total_tokens).toBe(37);
    expect(target.by_model).toEqual({
      opus: { prompt_tokens: 30, completion_tokens: 3, total_tokens: 33 },
      haiku: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
  });

  it('never mutates the usage being added', () => {
    const add = withModel('opus', { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 });
    const target = emptyTokenUsage();
    accumulateTokenUsage(target, add);
    accumulateTokenUsage(target, add);

    expect(add.by_model!.opus.total_tokens).toBe(11);
    expect(target.by_model!.opus.total_tokens).toBe(22);
  });

  it('is a no-op for an absent usage', () => {
    const target: TokenUsage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    expect(accumulateTokenUsage(target, undefined)).toEqual({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  });
});

describe('sumTokenUsage', () => {
  it('returns undefined when nothing was reported — an unmeasured run is not a free one', () => {
    expect(sumTokenUsage([])).toBeUndefined();
    expect(sumTokenUsage([undefined, undefined])).toBeUndefined();
  });

  it('sums what was reported, ignoring the gaps', () => {
    const summed = sumTokenUsage([
      withModel('opus', { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }),
      undefined,
      withModel('opus', { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }),
    ]);
    expect(summed?.total_tokens).toBe(17);
    expect(summed?.by_model).toEqual({ opus: { prompt_tokens: 15, completion_tokens: 2, total_tokens: 17 } });
  });
});
