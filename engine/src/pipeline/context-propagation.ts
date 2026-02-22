// Propagate context between stages
// Each stage gets the accumulated context from all previous stages

import * as yaml from 'js-yaml';
import type { StageDefinition, ToolCall } from '@studio/contracts';
import type { AgentContext } from '@studio/runner';

export type PipelineInput = string | Record<string, unknown>;

export interface GroupFeedback {
  iteration: number;
  max_iterations: number;
  rejection_reason: string;
  rejection_details?: string[];
}

export interface PipelineContext {
  input: PipelineInput;
  stageOutputs: Map<string, unknown>;
  stageToolResults: Map<string, ToolCall[]>;
  repoPath?: string;
  groupFeedback?: GroupFeedback;
  startupContext?: Record<string, string>;
}

export function createInitialContext(input: PipelineInput, repoPath?: string): PipelineContext {
  return {
    input,
    stageOutputs: new Map(),
    stageToolResults: new Map(),
    repoPath,
  };
}

export function addStageOutput(
  context: PipelineContext,
  stageName: string,
  output: unknown
): PipelineContext {
  context.stageOutputs.set(stageName, output);
  return context;
}

export function addStageToolResults(
  context: PipelineContext,
  stageName: string,
  toolCalls: ToolCall[]
): PipelineContext {
  context.stageToolResults.set(stageName, toolCalls);
  return context;
}

export function setGroupFeedback(
  context: PipelineContext,
  feedback: GroupFeedback
): void {
  context.groupFeedback = feedback;
}

export function clearGroupFeedback(context: PipelineContext): void {
  context.groupFeedback = undefined;
}

export function getContextForStage(
  context: PipelineContext,
  stage: StageDefinition,
  previousStageName?: string
): AgentContext {
  const agentContext: AgentContext = {};
  const includes = stage.context?.include ?? ['input'];

  for (const include of includes) {
    switch (include) {
      case 'input':
        agentContext.additional_context = typeof context.input === 'string'
          ? context.input
          : yaml.dump(context.input, { lineWidth: 120 });
        break;

      case 'previous_stage_output':
        if (previousStageName) {
          const output = context.stageOutputs.get(previousStageName);
          if (output !== undefined) {
            agentContext.previous_outputs = {
              ...agentContext.previous_outputs,
              [previousStageName]: output,
            };
          }
        }
        break;

      case 'all_stage_outputs':
        agentContext.previous_outputs = {
          ...agentContext.previous_outputs,
          ...Object.fromEntries(context.stageOutputs),
        };
        break;

      case 'group_feedback':
        if (context.groupFeedback) {
          const fb = context.groupFeedback;
          const lines = [
            `\n## FEEDBACK (Iteration ${fb.iteration + 1}/${fb.max_iterations})`,
            ``,
            `The previous output was REJECTED.`,
            `Reason: ${fb.rejection_reason}`,
          ];

          if (fb.rejection_details?.length) {
            lines.push(``, `Issues:`);
            for (const detail of fb.rejection_details) {
              lines.push(`  - ${detail}`);
            }
          }

          lines.push(``, `Address all issues listed above.`);

          agentContext.additional_context =
            (agentContext.additional_context || '') + '\n' + lines.join('\n');
        }
        break;

      case 'previous_stage_tool_results':
        if (previousStageName) {
          const toolResults = context.stageToolResults.get(previousStageName);
          if (toolResults) {
            agentContext.previous_tool_results = {
              ...agentContext.previous_tool_results,
              [previousStageName]: toolResults,
            };
          }
        }
        break;

      case 'all_stage_tool_results':
        if (context.stageToolResults.size > 0) {
          agentContext.previous_tool_results = {
            ...agentContext.previous_tool_results,
            ...Object.fromEntries(context.stageToolResults),
          };
        }
        break;

      case 'repo_files':
      case 'repo_structure':
        // Mark that repo files are needed — the engine populates this
        agentContext.repo_files = agentContext.repo_files ?? [];
        break;

      case 'pipeline_start_context':
        if (context.startupContext && Object.keys(context.startupContext).length > 0) {
          (agentContext as any).startup_context = context.startupContext;
        }
        break;
    }
  }

  return agentContext;
}
