import type { ToolCallStartEvent, ToolCallCompleteEvent, AgentThinkingEvent, AgentProgressEvent, AgentTokenEvent } from '@studio/contracts';

// Event types for pipeline observability
// Dedicated event types — separate from contract types (PipelineRun, StageRun)

export interface ToolCallSummary {
  name: string;
  arguments_summary: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface PipelineStartEvent {
  pipeline_name: string;
  run_id: string;
}

export interface PipelineCompleteEvent {
  pipeline_name: string;
  run_id: string;
  status: string;
  duration_ms: number;
  total_tokens: number;
  total_tool_calls: number;
}

export interface PipelineCancelledEvent {
  run_id: string;
  cancelled_at_stage: string;
  duration_ms: number;
}

export interface StageStartEvent {
  stage_name: string;
  stage_index: number;
  total_stages: number;
  max_attempts: number;
}

export interface StageCompleteEvent {
  stage_name: string;
  stage_index: number;
  total_stages: number;
  status: string;
  attempts: number;
  duration_ms: number;
  output_summary?: string;
  output?: unknown;
  tool_calls?: ToolCallSummary[];
  token_usage?: TokenUsage;
  rejection_reason?: string;
  rejection_details?: string[];
}

export interface StageRetryEvent {
  stage: string;
  attempt: number;
  max_attempts: number;
  failures: string[];
  agent_output_raw?: string;
  tool_calls_count?: number;
}

export interface GroupStartEvent {
  group_name: string;
  max_iterations: number;
}

export interface GroupIterationEvent {
  group_name: string;
  iteration: number;
  max_iterations: number;
}

export interface GroupFeedbackEvent {
  group_name: string;
  iteration: number;
  rejection_reason: string;
  rejection_details: string[];
}

export interface GroupCompleteEvent {
  group_name: string;
  iterations: number;
  status: string;
}

export interface StagedAgentThinkingEvent extends AgentThinkingEvent {
  stage: string;
}

export interface StagedAgentProgressEvent extends AgentProgressEvent {
  stage: string;
}

export interface StagedAgentTokenEvent extends AgentTokenEvent {
  stage: string;
}

export interface EngineEvents {
  onPipelineStart?: (event: PipelineStartEvent) => void;
  onPipelineComplete?: (event: PipelineCompleteEvent) => void;
  onPipelineCancelled?: (event: PipelineCancelledEvent) => void;
  onStageStart?: (event: StageStartEvent) => void;
  onStageComplete?: (event: StageCompleteEvent) => void;
  onTaskRetry?: (event: StageRetryEvent) => void;
  onGroupStart?: (event: GroupStartEvent) => void;
  onGroupIteration?: (event: GroupIterationEvent) => void;
  onGroupFeedback?: (event: GroupFeedbackEvent) => void;
  onGroupComplete?: (event: GroupCompleteEvent) => void;
  // Real-time tool call streaming (used by --live mode)
  onToolCallStart?: (event: ToolCallStartEvent) => void;
  onToolCallComplete?: (event: ToolCallCompleteEvent) => void;
  // Agent thinking/progress (text content emitted alongside tool calls)
  onAgentThinking?: (event: StagedAgentThinkingEvent) => void;
  onAgentProgress?: (event: StagedAgentProgressEvent) => void;
  onAgentToken?: (event: StagedAgentTokenEvent) => void;
}

// Keep the generic event bus for other use cases
export type PipelineEvent =
  | { type: 'pipeline_start'; pipelineId: string }
  | { type: 'pipeline_complete'; pipelineId: string }
  | { type: 'stage_start'; stageId: string; stageName: string }
  | { type: 'stage_complete'; stageId: string; stageName: string }
  | { type: 'task_retry'; stageName: string; attempt: number; failures: string[]; rawOutput?: string }
  | { type: 'group_start'; groupName: string; maxIterations: number }
  | { type: 'group_iteration'; groupName: string; iteration: number; maxIterations: number }
  | { type: 'group_feedback'; groupName: string; iteration: number; rejectionReason: string }
  | { type: 'group_complete'; groupName: string; iterations: number; status: string };

export class PipelineEventEmitter {
  private listeners: Array<(event: PipelineEvent) => void> = [];

  on(listener: (event: PipelineEvent) => void): void {
    this.listeners.push(listener);
  }

  emit(event: PipelineEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
