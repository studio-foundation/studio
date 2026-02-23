// Stage status and results

export type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'rejected' | 'cancelled';

export type StageKind = string;

export interface StageResult {
  status: StageStatus;
  output?: unknown;
  error?: string;
  attempts: number;
  duration_ms: number;
}
