// THIS IS THE CRITICAL TEST
// Status derivation was the #1 bug in v6
// Write this test FIRST, then implement the function

import { describe, it, expect } from 'vitest';
import { deriveStageStatus } from '../../../src/state/status-derivation.js';
import type { RalphResult } from '@studio/ralph';
import type { StageStatus } from '@studio/contracts';

describe('deriveStageStatus', () => {
  it('ralph success → stage success', () => {
    const ralphResult: RalphResult<unknown> = {
      status: 'success',
      result: { output: 'some result' },
      attempts: 1
    };

    const stageStatus: StageStatus = deriveStageStatus(ralphResult);
    expect(stageStatus).toBe('success');
  });

  it('ralph exhausted → stage failed', () => {
    const ralphResult: RalphResult<unknown> = {
      status: 'exhausted',
      lastResult: { output: 'failed result' },
      failures: ['Validation failed', 'Tool call missing'],
      attempts: 3
    };

    const stageStatus: StageStatus = deriveStageStatus(ralphResult);
    expect(stageStatus).toBe('failed');
  });

  it('success after multiple attempts → stage success', () => {
    const ralphResult: RalphResult<unknown> = {
      status: 'success',
      result: { output: 'finally worked' },
      attempts: 4
    };

    const stageStatus: StageStatus = deriveStageStatus(ralphResult);
    expect(stageStatus).toBe('success');
  });

  it('success after 1 attempt → stage success', () => {
    const ralphResult: RalphResult<unknown> = {
      status: 'success',
      result: null,
      attempts: 1
    };

    const stageStatus: StageStatus = deriveStageStatus(ralphResult);
    expect(stageStatus).toBe('success');
  });

  it('exhausted after max attempts → stage failed', () => {
    const ralphResult: RalphResult<unknown> = {
      status: 'exhausted',
      lastResult: {},
      failures: ['Error 1', 'Error 2', 'Error 3'],
      attempts: 5
    };

    const stageStatus: StageStatus = deriveStageStatus(ralphResult);
    expect(stageStatus).toBe('failed');
  });

  it('ralph cancelled → stage cancelled', () => {
    const ralphResult = {
      status: 'cancelled' as const,
      lastResult: undefined,
      attempts: 2,
    };

    const stageStatus = deriveStageStatus(ralphResult as any);
    expect(stageStatus).toBe('cancelled');
  });

  it('throws error for invalid ralph status', () => {
    const invalidResult = {
      status: 'invalid_status' as any,
      result: {},
      attempts: 1
    };

    expect(() => deriveStageStatus(invalidResult as any)).toThrow('Unknown ralph status');
  });
});
