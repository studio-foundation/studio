// GroupOrchestrator — extracted from PipelineEngine.runGroup/runGroupParallel/runGroupSequential()
// Handles group-level orchestration: parallel and sequential iteration with feedback loops.

import type { StageGroup, StageRun, StageStatus } from '@studio/contracts';
import {
  addStageOutput,
  addStageToolResults,
  setGroupFeedback,
  type PipelineContext,
} from './context-propagation.js';
import type { EngineEvents, PipelineEventEmitter } from '../events.js';
import type { ToolRegistry, AnonymizationMiddleware } from '@studio/runner';
import type { StageExecutor } from './stage-executor.js';
import type { GroupResult, ProjectPaths, StageResult } from './types.js';

export interface GroupOrchestratorConfig {
  events?: EngineEvents;
  emitter: PipelineEventEmitter;
  stageExecutor: StageExecutor;
}

export class GroupOrchestrator {
  constructor(private config: GroupOrchestratorConfig) {}

  async run(
    group: StageGroup,
    context: PipelineContext,
    stageOffset: number,
    totalStages: number,
    userInput: string | Record<string, unknown>,
    paths: ProjectPaths,
    toolRegistry: ToolRegistry | undefined,
    runMiddleware?: AnonymizationMiddleware | null,
    runId?: string,
    signal?: AbortSignal,
    skipSet?: Set<string>,
    originalRunId?: string,
  ): Promise<GroupResult> {
    if (group.mode === 'parallel') {
      return this.runParallel(group, context, stageOffset, totalStages, userInput, paths, toolRegistry, runMiddleware, runId, signal);
    }
    return this.runSequential(group, context, stageOffset, totalStages, userInput, paths, toolRegistry, runMiddleware, runId, signal, skipSet, originalRunId);
  }

  private async runParallel(
    group: StageGroup,
    context: PipelineContext,
    stageOffset: number,
    totalStages: number,
    userInput: string | Record<string, unknown>,
    paths: ProjectPaths,
    toolRegistry: ToolRegistry | undefined,
    runMiddleware?: AnonymizationMiddleware | null,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<GroupResult> {
    let totalTokensDelta = 0;
    let totalToolCallsDelta = 0;

    this.config.events?.onGroupStart?.({
      group_name: group.group,
      max_iterations: group.max_iterations,
      parallel: true,
    });
    this.config.emitter.emit({
      type: 'group_start',
      groupName: group.group,
      maxIterations: group.max_iterations,
    });

    // Parallel groups run exactly one iteration
    this.config.events?.onGroupIteration?.({
      group_name: group.group,
      iteration: 1,
      max_iterations: group.max_iterations,
    });
    this.config.emitter.emit({
      type: 'group_iteration',
      groupName: group.group,
      iteration: 1,
      maxIterations: group.max_iterations,
    });

    if (signal?.aborted) {
      this.config.events?.onGroupComplete?.({ group_name: group.group, iterations: 1, status: 'cancelled' });
      this.config.emitter.emit({ type: 'group_complete', groupName: group.group, iterations: 1, status: 'cancelled' });
      return { status: 'cancelled', stageRuns: [], stagesExecuted: group.stages.length, context, totalTokensDelta, totalToolCallsDelta };
    }

    // All parallel stages read the same pre-group context snapshot.
    // previousStageName = the last stage before this group.
    let previousStageName: string | undefined;
    for (const [name] of context.stageOutputs) {
      previousStageName = name;
    }

    // fail-fast: create a shared AbortController to cancel siblings on first failure
    const groupAbort = (group.on_failure ?? 'fail-fast') === 'fail-fast'
      ? new AbortController()
      : null;
    if (groupAbort && signal) {
      signal.addEventListener('abort', () => groupAbort.abort(), { once: true });
    }
    const stageSignal = groupAbort?.signal ?? signal;

    // Launch all stages concurrently
    const settled = await Promise.allSettled(
      group.stages.map(async (stage, i) => {
        const result = await this.config.stageExecutor.execute(
          stage,
          context,
          previousStageName,
          userInput,
          stageOffset + i,
          totalStages,
          paths,
          toolRegistry,
          runMiddleware,
          runId,
          stageSignal,
        );
        // fail-fast: abort remaining stages on first non-success
        if (groupAbort && result.status !== 'success') {
          groupAbort.abort();
        }
        return { stageName: stage.name, result };
      }),
    );

    // Build result map keyed by stage name
    const resultMap = new Map<string, StageResult>();
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        resultMap.set(s.value.stageName, s.value.result);
      }
    }

    // Collect stage runs in definition order (deterministic output ordering)
    const allStageRuns: StageRun[] = [];
    for (const stage of group.stages) {
      const result = resultMap.get(stage.name);
      if (result) allStageRuns.push(result.stageRun);
    }

    // After building resultMap, accumulate token/tool call totals
    for (const [, result] of resultMap) {
      totalTokensDelta += result.tokensDelta ?? 0;
      totalToolCallsDelta += result.toolCallsDelta ?? 0;
    }

    // Derive group status: cancelled > failed > success
    // rejected treated as failed in parallel mode (no feedback loop)
    let groupStatus: StageStatus = 'success';
    for (const stage of group.stages) {
      const result = resultMap.get(stage.name);
      if (!result) { groupStatus = 'failed'; continue; }
      if (result.status === 'cancelled' && groupStatus === 'success') groupStatus = 'cancelled';
      if (result.status === 'failed' || result.status === 'rejected') groupStatus = 'failed';
    }

    // If every stage was skipped, the group is skipped (not success)
    const allSkipped = group.stages.every(
      (s) => resultMap.get(s.name)?.status === 'skipped',
    );
    if (allSkipped) groupStatus = 'skipped';

    // Merge successful outputs into context in definition order (regardless of group status)
    // This preserves observability for collect-all partial failures
    for (const stage of group.stages) {
      const result = resultMap.get(stage.name);
      if (!result || result.status !== 'success') continue;
      if (result.lastAgentOutput !== undefined) {
        addStageOutput(context, stage.name, result.lastAgentOutput);
      }
      if (result.toolCalls?.length) {
        addStageToolResults(context, stage.name, result.toolCalls);
      }
    }

    this.config.events?.onGroupComplete?.({ group_name: group.group, iterations: 1, status: groupStatus });
    this.config.emitter.emit({ type: 'group_complete', groupName: group.group, iterations: 1, status: groupStatus });

    return {
      status: groupStatus,
      stageRuns: allStageRuns,
      stagesExecuted: group.stages.length,
      context,
      totalTokensDelta,
      totalToolCallsDelta,
    };
  }

  private async runSequential(
    group: StageGroup,
    context: PipelineContext,
    stageOffset: number,
    totalStages: number,
    userInput: string | Record<string, unknown>,
    paths: ProjectPaths,
    toolRegistry: ToolRegistry | undefined,
    runMiddleware?: AnonymizationMiddleware | null,
    runId?: string,
    signal?: AbortSignal,
    skipSet?: Set<string>,
    originalRunId?: string,
  ): Promise<GroupResult> {
    const allStageRuns: StageRun[] = [];
    let iteration = 0;
    let totalTokensDelta = 0;
    let totalToolCallsDelta = 0;

    this.config.events?.onGroupStart?.({
      group_name: group.group,
      max_iterations: group.max_iterations,
    });
    this.config.emitter.emit({
      type: 'group_start',
      groupName: group.group,
      maxIterations: group.max_iterations,
    });

    while (iteration < group.max_iterations) {
      // Check cancellation before group iteration
      if (signal?.aborted) {
        this.config.events?.onGroupComplete?.({
          group_name: group.group,
          iterations: iteration,
          status: 'cancelled',
        });
        this.config.emitter.emit({
          type: 'group_complete',
          groupName: group.group,
          iterations: iteration,
          status: 'cancelled',
        });
        return {
          status: 'cancelled',
          stageRuns: allStageRuns,
          stagesExecuted: group.stages.length,
          context,
          totalTokensDelta,
          totalToolCallsDelta,
        };
      }

      iteration++;

      this.config.events?.onGroupIteration?.({
        group_name: group.group,
        iteration,
        max_iterations: group.max_iterations,
      });
      this.config.emitter.emit({
        type: 'group_iteration',
        groupName: group.group,
        iteration,
        maxIterations: group.max_iterations,
      });

      let groupSucceeded = true;
      let anyStageExecuted = false;
      let previousStageName: string | undefined;
      // Find the last stage name before this group in the pipeline context
      for (const [name] of context.stageOutputs) {
        previousStageName = name;
      }

      for (let i = 0; i < group.stages.length; i++) {
        if (signal?.aborted) break;

        const stage = group.stages[i];
        const stageNumber = stageOffset + i;

        // On iteration 1 only, skip stages before resumeFromStage
        if (iteration === 1 && skipSet?.has(stage.name)) {
          const now = new Date().toISOString();
          const skippedReason = originalRunId
            ? `resumed from run ${originalRunId}`
            : 'resumed from prior run';
          const skippedRun: StageRun = {
            id: `skipped-${stage.name}`,
            stage_name: stage.name,
            status: 'skipped',
            started_at: now,
            completed_at: now,
            tasks: [],
            skipped_reason: skippedReason,
          };
          this.config.events?.onStageComplete?.({
            stage_name: stage.name,
            stage_index: stageNumber,
            total_stages: totalStages,
            status: 'skipped',
            attempts: 0,
            duration_ms: 0,
            skipped_reason: skippedReason,
          });
          allStageRuns.push(skippedRun);
          previousStageName = stage.name;
          continue;
        }

        const result = await this.config.stageExecutor.execute(
          stage,
          context,
          previousStageName,
          userInput,
          stageNumber,
          totalStages,
          paths,
          toolRegistry,
          runMiddleware,
          runId,
          signal,
        );

        allStageRuns.push(result.stageRun);
        totalTokensDelta += result.tokensDelta ?? 0;
        totalToolCallsDelta += result.toolCallsDelta ?? 0;
        if (result.status !== 'skipped') anyStageExecuted = true;

        // Cancelled → stop group
        if (result.status === 'cancelled') {
          this.config.events?.onGroupComplete?.({
            group_name: group.group,
            iterations: iteration,
            status: 'cancelled',
          });
          this.config.emitter.emit({
            type: 'group_complete',
            groupName: group.group,
            iterations: iteration,
            status: 'cancelled',
          });
          return {
            status: 'cancelled',
            stageRuns: allStageRuns,
            stagesExecuted: group.stages.length,
            context,
            totalTokensDelta,
            totalToolCallsDelta,
          };
        }

        // Technical failure → stop everything
        if (result.status === 'failed') {
          this.config.events?.onGroupComplete?.({
            group_name: group.group,
            iterations: iteration,
            status: 'failed',
          });
          this.config.emitter.emit({
            type: 'group_complete',
            groupName: group.group,
            iterations: iteration,
            status: 'failed',
          });
          return {
            status: 'failed',
            stageRuns: allStageRuns,
            stagesExecuted: group.stages.length,
            context,
            totalTokensDelta,
            totalToolCallsDelta,
          };
        }

        // Propagate output to context (will be cleared if we loop)
        if (result.lastAgentOutput !== undefined) {
          addStageOutput(context, stage.name, result.lastAgentOutput);
        }
        if (result.toolCalls && result.toolCalls.length > 0) {
          addStageToolResults(context, stage.name, result.toolCalls);
        }
        previousStageName = stage.name;

        // Last stage rejected → feedback loop
        const isLastStage = i === group.stages.length - 1;
        if (result.status === 'rejected' && isLastStage) {
          groupSucceeded = false;

          if (iteration < group.max_iterations) {
            // Clear group stage outputs and tool results for next iteration
            for (const gs of group.stages) {
              context.stageOutputs.delete(gs.name);
              context.stageToolResults.delete(gs.name);
            }

            // Set feedback for next iteration
            setGroupFeedback(context, {
              iteration,
              max_iterations: group.max_iterations,
              rejection_reason: result.postValidation?.rejection_reason || 'Rejected',
              rejection_details: result.postValidation?.rejection_details,
            });

            this.config.events?.onGroupFeedback?.({
              group_name: group.group,
              iteration,
              rejection_reason: result.postValidation?.rejection_reason || 'Rejected',
              rejection_details: result.postValidation?.rejection_details || [],
            });
            this.config.emitter.emit({
              type: 'group_feedback',
              groupName: group.group,
              iteration,
              rejectionReason: result.postValidation?.rejection_reason || 'Rejected',
            });
          }

          break; // Exit inner stage loop, retry group
        }

        // Non-gate stage rejected → stop
        if (result.status === 'rejected') {
          this.config.events?.onGroupComplete?.({
            group_name: group.group,
            iterations: iteration,
            status: 'rejected',
          });
          this.config.emitter.emit({
            type: 'group_complete',
            groupName: group.group,
            iterations: iteration,
            status: 'rejected',
          });
          return {
            status: 'rejected',
            stageRuns: allStageRuns,
            stagesExecuted: group.stages.length,
            context,
            totalTokensDelta,
            totalToolCallsDelta,
          };
        }
      }

      if (groupSucceeded) {
        const groupStatus = anyStageExecuted ? 'success' : 'skipped';
        this.config.events?.onGroupComplete?.({
          group_name: group.group,
          iterations: iteration,
          status: groupStatus,
        });
        this.config.emitter.emit({
          type: 'group_complete',
          groupName: group.group,
          iterations: iteration,
          status: groupStatus,
        });
        return {
          status: groupStatus,
          stageRuns: allStageRuns,
          stagesExecuted: group.stages.length,
          context,
          totalTokensDelta,
          totalToolCallsDelta,
        };
      }
    }

    // Max iterations exhausted
    this.config.events?.onGroupComplete?.({
      group_name: group.group,
      iterations: iteration,
      status: 'rejected',
    });
    this.config.emitter.emit({
      type: 'group_complete',
      groupName: group.group,
      iterations: iteration,
      status: 'rejected',
    });
    return {
      status: 'rejected',
      stageRuns: allStageRuns,
      stagesExecuted: group.stages.length,
      context,
      totalTokensDelta,
      totalToolCallsDelta,
    };
  }
}
