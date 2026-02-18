// Stage status and results

export type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'rejected';

export type StageKind = string;

export interface StageResult {
  status: StageStatus;
  output?: unknown;
  error?: string;
  attempts: number;
  duration_ms: number;
}
