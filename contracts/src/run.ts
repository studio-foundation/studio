// Runtime execution tracking

import type { StageStatus } from './stage';
import type { TaskStatus } from './task';
import type { TokenUsage } from './usage';

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
  // Owning process identity, stamped at creation while status is `running`.
  // Lets a reader detect an orphaned `running` row whose process died without
  // writing a terminal status (SIGKILL, OOM, force-quit) and reconcile it.
  pid?: number;
  hostname?: string;
}

export interface StageRun {
  id: string;
  stage_name: string;
  status: StageStatus;
  started_at: string;
  completed_at?: string;
  tasks: TaskRun[];
  output?: unknown;  // final output of the stage (populated by engine for observability)
  skipped_reason?: string;  // reason why stage was skipped (populated by resume loop)
  // For a `call` stage: the run id of the child pipeline it spawned. Lets a
  // reader (e.g. `studio status`) load and nest the child's own stages instead
  // of hand-mapping interleaved run logs.
  child_run_id?: string;
  // What the stage spent, summed over every attempt of its RALPH loop. A `call`
  // or `map` stage carries the total of the child runs it spawned — those runs
  // are not in `stages`, so a per-run total never double-counts them.
  token_usage?: TokenUsage;
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
