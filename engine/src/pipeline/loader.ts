// Load pipeline definitions from YAML files

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { PipelineDefinition, PipelineEntry, StageGroup, StageDefinition, MapStage, StartupCommand, StageHooks } from '@studio-foundation/contracts';
import { assertKnownFields, suggestClosest } from './strict-fields.js';
import { CONTEXT_INCLUDE_DIRECTIVES } from './context-propagation.js';

// Every field the kernel implements, per block (see PipelineDefinition and
// friends in @studio-foundation/contracts). Anything else is config-theatre
// and must be rejected at load time, not silently ignored.
const PIPELINE_FIELDS = [
  'name', 'description', 'version', 'on_pipeline_start', 'input_schema', 'repo', 'stages',
] as const;
const STAGE_FIELDS = [
  'name', 'condition', 'kind', 'agent', 'executor', 'script', 'runtime',
  'timeout_ms', 'contract', 'ralph', 'context', 'tools', 'hooks',
] as const;
const GROUP_FIELDS = ['group', 'max_iterations', 'mode', 'on_failure', 'stages'] as const;
const MAP_FIELDS = ['map', 'condition', 'over', 'pipeline', 'input', 'as', 'concurrency', 'on_item_failure'] as const;
const RALPH_FIELDS = ['max_attempts', 'retry_strategy', 'max_tool_calls'] as const;
const CONTEXT_FIELDS = ['include', 'packs'] as const;
const TOOLS_FIELDS = ['required'] as const;
const HOOKS_FIELDS = ['on_stage_start', 'on_stage_complete', 'pre_tool_use', 'post_tool_use'] as const;
const STAGE_HOOK_FIELDS = ['command', 'on_failure'] as const;
const TOOL_HOOK_FIELDS = ['matcher', 'command', 'on_failure'] as const;
const STARTUP_COMMAND_FIELDS = ['command', 'inject_as'] as const;
const REPO_FIELDS = ['url', 'branch'] as const;
const INPUT_SCHEMA_FIELDS = ['type', 'fields'] as const;
const INPUT_FIELD_FIELDS = ['name', 'type', 'prompt', 'required', 'default', 'items'] as const;

/** assertKnownFields on a block only if it is a plain object. */
function checkBlock(
  block: unknown,
  allowed: readonly string[],
  what: string,
  context: string
): void {
  if (block && typeof block === 'object' && !Array.isArray(block)) {
    assertKnownFields(block as Record<string, unknown>, allowed, what, context);
  }
}

/**
 * Reject a `context.include` directive the kernel does not implement. The block
 * keys (include/packs) are already checked; this checks the include *values* —
 * an unknown one has no switch case in getContextForStage and is silently
 * dropped, so the user believes a context is wired that never arrives (STU-593).
 */
function checkContextInclude(stage: any, context: string): void {
  const includes = stage.context?.include;
  if (!Array.isArray(includes)) return;
  for (const directive of includes) {
    if (typeof directive === 'string' && !(CONTEXT_INCLUDE_DIRECTIVES as readonly string[]).includes(directive)) {
      const suggestion = suggestClosest(directive, CONTEXT_INCLUDE_DIRECTIVES);
      throw new Error(
        `Unknown context.include '${directive}' in stage '${stage.name}'${context}.` +
        (suggestion ? ` Did you mean '${suggestion}'?` : '') +
        ` Known directives: ${[...CONTEXT_INCLUDE_DIRECTIVES].sort().join(', ')}.`
      );
    }
  }
}

/** Strict-check a stage and every nested block the kernel owns. */
function checkStageFields(stage: any, context: string): void {
  const inStage = `of stage '${stage.name}'`;
  assertKnownFields(stage, STAGE_FIELDS, `stage '${stage.name}'`, context);
  checkBlock(stage.ralph, RALPH_FIELDS, `ralph ${inStage}`, context);
  checkBlock(stage.context, CONTEXT_FIELDS, `context ${inStage}`, context);
  checkContextInclude(stage, context);
  checkBlock(stage.tools, TOOLS_FIELDS, `tools ${inStage}`, context);
  checkBlock(stage.hooks, HOOKS_FIELDS, `hooks ${inStage}`, context);
  if (stage.hooks && typeof stage.hooks === 'object') {
    for (const point of HOOKS_FIELDS) {
      const entries = stage.hooks[point];
      if (!Array.isArray(entries)) continue;
      const allowed = point.startsWith('on_stage') ? STAGE_HOOK_FIELDS : TOOL_HOOK_FIELDS;
      for (const entry of entries) {
        checkBlock(entry, allowed, `hooks.${point} entry ${inStage}`, context);
      }
    }
  }
}

export async function loadPipeline(path: string): Promise<PipelineDefinition> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to load pipeline at ${path}: ${(err as Error).message}`);
  }

  return parsePipelineYaml(content, path);
}

export async function loadPipelineByName(
  name: string,
  pipelinesDir: string
): Promise<PipelineDefinition> {
  const path = join(pipelinesDir, `${name}.pipeline.yaml`);
  return loadPipeline(path);
}

export function parsePipelineYaml(yamlContent: string, sourcePath?: string): PipelineDefinition {
  const parsed = yaml.load(yamlContent) as Record<string, unknown>;
  const context = sourcePath ? ` (from ${sourcePath})` : '';

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid pipeline YAML: expected an object${context}`);
  }

  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error(`Pipeline missing required field 'name'${context}`);
  }

  if (!Array.isArray(parsed.stages)) {
    throw new Error(`Pipeline missing required field 'stages'${context}`);
  }

  if (parsed.stages.length === 0) {
    throw new Error(`Pipeline must have at least one stage${context}`);
  }

  assertKnownFields(parsed, PIPELINE_FIELDS, `pipeline '${parsed.name}'`, context);
  checkBlock(parsed.repo, REPO_FIELDS, `repo of pipeline '${parsed.name}'`, context);
  checkBlock(parsed.input_schema, INPUT_SCHEMA_FIELDS, `input_schema of pipeline '${parsed.name}'`, context);
  const inputFields = (parsed.input_schema as Record<string, unknown> | undefined)?.fields;
  if (Array.isArray(inputFields)) {
    for (const f of inputFields) {
      checkBlock(f, INPUT_FIELD_FIELDS, `input_schema field of pipeline '${parsed.name}'`, context);
    }
  }
  if (Array.isArray(parsed.on_pipeline_start)) {
    for (const cmd of parsed.on_pipeline_start) {
      checkBlock(cmd, STARTUP_COMMAND_FIELDS, `on_pipeline_start entry of pipeline '${parsed.name}'`, context);
    }
  }

  const stages: PipelineEntry[] = [];
  for (const entry of parsed.stages as any[]) {
    if (entry.map !== undefined) {
      // Fan-out / map stage
      stages.push(parseMapStage(entry, context));
    } else if (entry.group) {
      // Group entry
      assertKnownFields(entry, GROUP_FIELDS, `group '${entry.group}'`, context);
      if (!Array.isArray(entry.stages) || entry.stages.length < 2) {
        throw new Error(`Group '${entry.group}' must have at least 2 stages${context}`);
      }
      for (const s of entry.stages) {
        validateStageFields(s, context);
        checkStageFields(s, context);
      }

      const mode = entry.mode === 'parallel' ? 'parallel' : undefined;
      let maxIterations: number = entry.max_iterations ?? 3;

      if (mode === 'parallel' && maxIterations > 1) {
        console.warn(
          `[studio] parallel group '${entry.group}' has max_iterations > 1 — iterations are ignored in parallel mode, using 1`
        );
        maxIterations = 1;
      }

      stages.push({
        group: entry.group,
        max_iterations: maxIterations,
        ...(mode ? { mode } : {}),
        ...(entry.on_failure ? { on_failure: entry.on_failure } : {}),
        stages: entry.stages.map((s: any) => ({ ...s, hooks: parseStageHooks(s) })),
      } as StageGroup);
    } else {
      // Simple stage
      validateStageFields(entry, context);
      checkStageFields(entry, context);
      stages.push({ ...entry, hooks: parseStageHooks(entry) } as StageDefinition);
    }
  }

  // Parse on_pipeline_start commands
  let on_pipeline_start: StartupCommand[] | undefined;
  if (Array.isArray(parsed.on_pipeline_start)) {
    on_pipeline_start = [];
    for (const cmd of parsed.on_pipeline_start as any[]) {
      if (!cmd.command || typeof cmd.command !== 'string') {
        throw new Error(`on_pipeline_start entry missing 'command'${context}`);
      }
      if (!cmd.inject_as || typeof cmd.inject_as !== 'string') {
        throw new Error(`on_pipeline_start entry missing 'inject_as'${context}`);
      }
      on_pipeline_start.push({ command: cmd.command, inject_as: cmd.inject_as });
    }
    if (on_pipeline_start.length === 0) {
      on_pipeline_start = undefined;
    }
  }

  return {
    ...parsed,
    stages,
    on_pipeline_start,
  } as unknown as PipelineDefinition;
}

function parseStageHooks(entry: any): StageHooks | undefined {
  if (!entry.hooks || typeof entry.hooks !== 'object') return undefined;
  const h = entry.hooks;
  const result: StageHooks = {};

  if (Array.isArray(h.on_stage_start)) {
    result.on_stage_start = h.on_stage_start.map((hk: any) => ({
      command: String(hk.command ?? ''),
      on_failure: hk.on_failure ?? 'warn',
    }));
  }
  if (Array.isArray(h.on_stage_complete)) {
    result.on_stage_complete = h.on_stage_complete.map((hk: any) => ({
      command: String(hk.command ?? ''),
      on_failure: hk.on_failure ?? 'warn',
    }));
  }
  if (Array.isArray(h.pre_tool_use)) {
    result.pre_tool_use = h.pre_tool_use.map((hk: any) => ({
      matcher: String(hk.matcher ?? ''),
      command: String(hk.command ?? ''),
      on_failure: hk.on_failure ?? 'warn',
    }));
  }
  if (Array.isArray(h.post_tool_use)) {
    result.post_tool_use = h.post_tool_use.map((hk: any) => ({
      matcher: String(hk.matcher ?? ''),
      command: String(hk.command ?? ''),
      on_failure: hk.on_failure ?? 'warn',
    }));
  }

  const hasAny = result.on_stage_start || result.on_stage_complete
    || result.pre_tool_use || result.post_tool_use;
  return hasAny ? result : undefined;
}

function validateStageFields(stage: any, context: string): void {
  if (!stage.name) throw new Error(`Stage missing 'name'${context}`);
  if (!stage.kind && !stage.executor) throw new Error(`Stage '${stage.name}' missing 'kind'${context}`);
  if (!stage.agent && stage.executor !== 'script') throw new Error(`Stage '${stage.name}' missing 'agent'${context}`);
  if (stage.executor === 'script' && !stage.script) throw new Error(`Stage '${stage.name}' missing 'script' (required when executor: 'script')${context}`);
}

function parseMapStage(entry: any, context: string): MapStage {
  const name = entry.map;
  if (!name || typeof name !== 'string') {
    throw new Error(`Map stage missing 'map' (the fan-out stage name)${context}`);
  }
  assertKnownFields(entry, MAP_FIELDS, `map stage '${name}'`, context);

  if (!entry.over || typeof entry.over !== 'string') {
    throw new Error(`Map stage '${name}' missing 'over' (context path to the list, e.g. stages.plan.output.items)${context}`);
  }
  if (!entry.pipeline || typeof entry.pipeline !== 'string') {
    throw new Error(`Map stage '${name}' missing 'pipeline' (the sub-pipeline to run per item)${context}`);
  }
  if (entry.input !== undefined && (typeof entry.input !== 'object' || entry.input === null || Array.isArray(entry.input))) {
    throw new Error(`Map stage '${name}' field 'input' must be an object of key → template${context}`);
  }
  if (entry.as !== undefined && typeof entry.as !== 'string') {
    throw new Error(`Map stage '${name}' field 'as' must be a string${context}`);
  }
  if (entry.concurrency !== undefined) {
    if (typeof entry.concurrency !== 'number' || !Number.isInteger(entry.concurrency) || entry.concurrency < 1) {
      throw new Error(`Map stage '${name}' field 'concurrency' must be a positive integer${context}`);
    }
  }
  const onItemFailure = entry.on_item_failure ?? 'fail-fast';
  if (onItemFailure !== 'fail-fast' && onItemFailure !== 'collect-all') {
    throw new Error(`Map stage '${name}' field 'on_item_failure' must be 'fail-fast' or 'collect-all'${context}`);
  }

  return {
    map: name,
    over: entry.over,
    pipeline: entry.pipeline,
    ...(entry.condition !== undefined ? { condition: entry.condition } : {}),
    ...(entry.input !== undefined ? { input: entry.input } : {}),
    ...(entry.as !== undefined ? { as: entry.as } : {}),
    ...(entry.concurrency !== undefined ? { concurrency: entry.concurrency } : {}),
    on_item_failure: onItemFailure,
  };
}
