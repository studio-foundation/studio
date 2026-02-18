// Derive stage status from ralph result
// THIS IS THE CRITICAL FUNCTION
//
// In v7, each stage = 1 ralph call = 1 task.
// This function maps ralph's result directly to stage status.
//
// This was the #1 bug in v6: stage status didn't match task status.
// v7 fix: SIMPLE, DETERMINISTIC, NO MAGIC.

import type { RalphResult } from '@studio/ralph';
import type { StageStatus } from '@studio/contracts';

/**
 * Derives stage status from ralph result.
 *
 * Rules (simple and exhaustive):
 * - ralph 'success' → stage 'success'
 * - ralph 'exhausted' → stage 'failed'
 * - anything else → error (should never happen)
 */
export function deriveStageStatus(ralphResult: RalphResult<unknown>): StageStatus {
  if (ralphResult.status === 'success') {
    return 'success';
  }

  if (ralphResult.status === 'exhausted') {
    return 'failed';
  }

  // Should never reach here if RalphResult types are exhaustive
  throw new Error(`Unknown ralph status: ${(ralphResult as any).status}`);
}
