// Orphaned-run reconciliation.
//
// A run row is left at `status: running` when its owning process dies without
// writing a terminal status — SIGKILL, OOM, a force-quit that skips cleanup.
// The row then lies about the run forever. Since children (`map`/`call`) run
// in the same OS process, they carry the same pid and are reconciled together.

import os from 'node:os';
import type { PipelineRun } from '@studio-foundation/contracts';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: process exists but isn't ours to signal — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A `running` row is orphaned when it was owned by this host and its process is
 * gone. Runs from another host, or without owner info, can't be judged — leave
 * them as-is rather than risk a false `interrupted`.
 */
export function isRunOrphaned(run: PipelineRun): boolean {
  if (run.status !== 'running') return false;
  if (typeof run.pid !== 'number') return false;
  if (run.hostname && run.hostname !== os.hostname()) return false;
  return !isProcessAlive(run.pid);
}

/** Returns an `interrupted` copy if the run is orphaned, else the run unchanged. */
export function reconcileOrphan(run: PipelineRun): PipelineRun {
  if (!isRunOrphaned(run)) return run;
  return {
    ...run,
    status: 'interrupted',
    completed_at: run.completed_at ?? new Date().toISOString(),
  };
}
