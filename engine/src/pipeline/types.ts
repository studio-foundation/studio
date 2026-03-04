// engine/src/pipeline/types.ts
// Shared local types for pipeline execution — used by engine, StageExecutor, GroupOrchestrator

import { join } from 'node:path';
import type { StageRun, StageStatus, ToolCall } from '@studio/contracts';
import type { PostValidationResult } from './post-validator.js';
import type { PipelineContext } from './context-propagation.js';

export interface ProjectPaths {
  projectDir: string;
  pipelinesDir: string;
  agentsDir: string;
  contractsDir: string;
}

export function resolveProjectPaths(configsDir: string): ProjectPaths {
  return {
    projectDir: configsDir,
    pipelinesDir: join(configsDir, 'pipelines'),
    agentsDir: join(configsDir, 'agents'),
    contractsDir: join(configsDir, 'contracts'),
  };
}

export interface StageResult {
  stageRun: StageRun;
  status: StageStatus;
  postValidation?: PostValidationResult;
  lastAgentOutput?: unknown;
  toolCalls?: ToolCall[];
  tokensDelta?: number;       // tokens consumed by this stage
  toolCallsDelta?: number;    // tool calls made by this stage
}

export interface GroupResult {
  status: StageStatus;
  stageRuns: StageRun[];
  stagesExecuted: number;
  context: PipelineContext;
  totalTokensDelta: number;
  totalToolCallsDelta: number;
}
