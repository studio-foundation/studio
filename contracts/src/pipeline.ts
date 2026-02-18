// Pipeline and Stage definitions

import type { StageKind } from './stage';

export interface PipelineDefinition {
  name: string;
  description: string;
  version: number;
  repo?: {
    url: string;
    branch?: string;
  };
  stages: PipelineEntry[];
}

export interface StageDefinition {
  name: string;
  kind: StageKind;
  agent: string;
  contract?: string;
  ralph?: {
    max_attempts: number;
    retry_strategy: string;
    max_tool_calls?: number;
  };
  context?: {
    include: string[];
    packs?: string[];
  };
  tools?: {
    required?: string[];
  };
}

// A pipeline entry is either a stage or a group of stages
export type PipelineEntry = StageDefinition | StageGroup;

export interface StageGroup {
  group: string;
  max_iterations: number;
  stages: StageDefinition[];
}

export function isStageGroup(entry: PipelineEntry): entry is StageGroup {
  return 'group' in entry && 'stages' in entry;
}
