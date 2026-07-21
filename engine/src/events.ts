import type { ToolCall, ToolCallStartEvent, ToolCallCompleteEvent, AgentThinkingEvent, AgentProgressEvent, AgentTokenEvent } from '@studio-foundation/contracts';

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
  tool_calls?: ToolCall[];
  token_usage?: TokenUsage;
  rejection_reason?: string;
  rejection_details?: string[];
  skipped_reason?: string;
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
  parallel?: boolean;
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

export interface MapStartEvent {
  map_name: string;
  total_items: number;
  concurrency: number;
}

export interface MapItemStartEvent {
  map_name: string;
  index: number;
  total_items: number;
  /** Human-readable identity of the item (derived from the item, not just its index). */
  label: string;
}

export interface MapItemCompleteEvent {
  map_name: string;
  index: number;
  total_items: number;
  status: 'success' | 'failed';
  /** Human-readable identity of the item — same value as the matching MapItemStartEvent. */
  label?: string;
  run_id?: string;
  error?: string;
  /** True when the item was served from the resume cache (not spawned this run). */
  cached?: boolean;
}

export interface MapCompleteEvent {
  map_name: string;
  total: number;
  succeeded: number;
  failed: number;
  status: string;
}

export interface StageContextEvent {
  stage: string;
  run_id: string;
  context_keys: Record<string, number>;
  context_content?: Record<string, unknown>;
  system_prompt?: string;
}

export interface StagedToolCallStartEvent extends ToolCallStartEvent {
  stage: string;
}

export interface StagedToolCallCompleteEvent extends ToolCallCompleteEvent {
  stage: string;
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

/** Orchestration context stamped onto child-run events by the spawner. */
export interface EventContext {
  depth: number;   // 0 = top-level engine, 1+ = spawned child
  childId: string; // stable per child run, minted by the spawner
}

export interface EngineEvents {
  onPipelineStart?: (event: PipelineStartEvent, ctx?: EventContext) => void;
  onPipelineComplete?: (event: PipelineCompleteEvent, ctx?: EventContext) => void;
  onPipelineCancelled?: (event: PipelineCancelledEvent, ctx?: EventContext) => void;
  onStageStart?: (event: StageStartEvent, ctx?: EventContext) => void;
  onStageComplete?: (event: StageCompleteEvent, ctx?: EventContext) => void;
  onTaskRetry?: (event: StageRetryEvent, ctx?: EventContext) => void;
  onGroupStart?: (event: GroupStartEvent, ctx?: EventContext) => void;
  onGroupIteration?: (event: GroupIterationEvent, ctx?: EventContext) => void;
  onGroupFeedback?: (event: GroupFeedbackEvent, ctx?: EventContext) => void;
  onGroupComplete?: (event: GroupCompleteEvent, ctx?: EventContext) => void;
  onMapStart?: (event: MapStartEvent, ctx?: EventContext) => void;
  onMapItemStart?: (event: MapItemStartEvent, ctx?: EventContext) => void;
  onMapItemComplete?: (event: MapItemCompleteEvent, ctx?: EventContext) => void;
  onMapComplete?: (event: MapCompleteEvent, ctx?: EventContext) => void;
  onStageContext?: (event: StageContextEvent, ctx?: EventContext) => void;
  // Real-time tool call streaming (used by --live mode)
  onToolCallStart?: (event: StagedToolCallStartEvent, ctx?: EventContext) => void;
  onToolCallComplete?: (event: StagedToolCallCompleteEvent, ctx?: EventContext) => void;
  // Agent thinking/progress (text content emitted alongside tool calls)
  onAgentThinking?: (event: StagedAgentThinkingEvent, ctx?: EventContext) => void;
  onAgentProgress?: (event: StagedAgentProgressEvent, ctx?: EventContext) => void;
  onAgentToken?: (event: StagedAgentTokenEvent, ctx?: EventContext) => void;
}

/**
 * Wrap a parent event sink so a child run's events reach it stamped with `ctx`.
 * A Proxy forwards any defined handler, injecting ctx as the trailing argument;
 * the child engine keeps emitting one-arg calls unchanged.
 */
export function createTaggingAdapter(parent: EngineEvents, ctx: EventContext): EngineEvents {
  return new Proxy({} as EngineEvents, {
    get(_target, prop: string) {
      const handler = (parent as Record<string, unknown>)[prop];
      if (typeof handler !== 'function') return undefined;
      return (event: unknown) => (handler as (e: unknown, c: EventContext) => void).call(parent, event, ctx);
    },
  });
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
  | { type: 'group_complete'; groupName: string; iterations: number; status: string }
  | { type: 'map_start'; mapName: string; totalItems: number }
  | { type: 'map_item_complete'; mapName: string; index: number; status: string }
  | { type: 'map_complete'; mapName: string; succeeded: number; failed: number; status: string };

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
