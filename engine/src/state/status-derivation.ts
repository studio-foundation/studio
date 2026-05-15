// Derive stage status from ralph result
// THIS IS THE CRITICAL FUNCTION
//
// Each stage = 1 ralph call = 1 task.
// This function maps ralph's result directly to stage status.
//
// An earlier architectural bug let stage status drift from task status.
// The fix: SIMPLE, DETERMINISTIC, NO MAGIC.

import type { RalphResult } from '@studio-foundation/ralph';
import type { StageStatus } from '@studio-foundation/contracts';

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

  if (ralphResult.status === 'cancelled') {
    return 'cancelled';
  }

  // Should never reach here if RalphResult types are exhaustive
  throw new Error(`Unknown ralph status: ${JSON.stringify(ralphResult)}`);
}
