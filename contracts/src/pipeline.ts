// Pipeline and Stage definitions

import type { StageKind } from './stage';

export interface InputField {
  name: string;
  type: 'text' | 'array';
  prompt: string;
  required: boolean;
  default?: string;
  items?: 'text';
}

export interface InputSchema {
  type: 'structured';
  fields: InputField[];
}

export interface StartupCommand {
  command: string;
  inject_as: string;
}

export interface PipelineDefinition {
  name: string;
  description: string;
  version: number;
  on_pipeline_start?: StartupCommand[];
  input_schema?: InputSchema;
  repo?: {
    url: string;
    branch?: string;
  };
  stages: PipelineEntry[];
}

// Lifecycle hooks — configurable shell commands at stage/tool lifecycle points

export type HookOnFailure = 'warn' | 'reject' | 'fail';

export interface StageHookDef {
  command: string;
  on_failure?: HookOnFailure;  // default: 'warn'
}

export interface ToolHookDef {
  matcher: string;             // exact tool name to match (e.g. "repo_manager-write_file")
  command: string;
  on_failure?: 'warn' | 'reject';  // default: 'warn' — 'fail' not supported at tool boundary
}

export interface StageHooks {
  on_stage_start?: StageHookDef[];
  on_stage_complete?: StageHookDef[];
  pre_tool_use?: ToolHookDef[];
  post_tool_use?: ToolHookDef[];
}

export interface StageDefinition {
  name: string;
  condition?: string;   // e.g. "input.meals_count >= 6" or "stages.foo.output.count > 0"
  kind?: StageKind;
  agent?: string;           // optional — not needed for script executor
  executor?: 'script';      // 'script' or absent (defaults to LLM)
  script?: string;          // path to script file (required when executor: 'script')
  runtime?: 'python' | 'node' | 'shell'; // runtime for script executor
  timeout_ms?: number;      // script timeout in ms (default: 30000)
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
  hooks?: StageHooks;
}

// A pipeline entry is either a stage, a group of stages, or a fan-out over a list
export type PipelineEntry = StageDefinition | StageGroup | MapStage;

export interface StageGroup {
  group: string;
  max_iterations: number;
  mode?: 'sequential' | 'parallel';         // default: 'sequential'
  on_failure?: 'fail-fast' | 'collect-all'; // parallel only, default: 'fail-fast'
  stages: StageDefinition[];
}

/**
 * A fan-out / map stage: run a sub-pipeline once per item of a list, then
 * collect the structured outputs. Replaces the "shell `studio run` per item +
 * scrape the log" glue — the child runs are spawned in-process via the engine's
 * RunSpawner and their last-stage output is returned directly (no scraping).
 */
export interface MapStage {
  map: string;                              // the fan-out stage name (discriminant)
  condition?: string;                       // skip the whole fan-out if false
  over: string;                             // context path to the list: input.<path> | stages.<name>.output.<path>
  pipeline: string;                         // sub-pipeline run once per item
  /**
   * Per-item input template. Each value may reference the current item and the
   * pipeline input via {{item}}, {{item.<path>}}, {{index}}, {{input.<path>}}.
   * A value that is exactly "{{item}}" (or "{{input.x}}") keeps the resolved
   * value's native type; mixed strings interpolate to text.
   */
  input?: Record<string, unknown>;
  as?: string;                              // shorthand: input = { [as]: item } (ignored when `input` is set)
  concurrency?: number;                     // max items in flight, default 1 (sequential)
  on_item_failure?: 'fail-fast' | 'collect-all'; // default: 'fail-fast'
}

export function isStageGroup(entry: PipelineEntry): entry is StageGroup {
  return 'group' in entry && 'stages' in entry;
}

export function isMapStage(entry: PipelineEntry): entry is MapStage {
  return 'map' in entry && 'over' in entry;
}
