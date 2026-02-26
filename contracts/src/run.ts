// Runtime execution tracking

import type { StageStatus } from './stage';
import type { TaskStatus } from './task';

export type AgentStatus = 'pending' | 'running' | 'success' | 'failed';

export interface PipelineRun {
  id: string;
  pipeline_name: string;
  status: StageStatus;
  started_at: string;
  completed_at?: string;
  stages: StageRun[];
  input?: Record<string, unknown>;
  parent_run_id?: string;
}

export interface StageRun {
  id: string;
  stage_name: string;
  status: StageStatus;
  started_at: string;
  completed_at?: string;
  tasks: TaskRun[];
}

export interface TaskRun {
  id: string;
  task_name: string;
  status: TaskStatus;
  started_at: string;
  completed_at?: string;
  agent_runs: AgentRun[];
}

export interface AgentRun {
  id: string;
  agent_name: string;
  attempt: number;
  status: AgentStatus;
  tool_calls: number;
  started_at: string;
  completed_at?: string;
  output?: unknown;
  error?: string;
}
