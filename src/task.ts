// Task configuration and results

export type TaskStatus = 'pending' | 'running' | 'success' | 'failed';

export interface TaskConfig {
  name: string;
  description?: string;
  timeout_ms?: number;
}

export interface TaskResult {
  status: TaskStatus;
  output?: unknown;
  error?: string;
  duration_ms: number;
}
