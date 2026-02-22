// Load pipeline definitions from YAML files

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { PipelineDefinition, PipelineEntry, StageGroup, StageDefinition } from '@studio/contracts';

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

  const stages: PipelineEntry[] = [];
  for (const entry of parsed.stages as any[]) {
    if (entry.group) {
      // Group entry
      if (!Array.isArray(entry.stages) || entry.stages.length < 2) {
        throw new Error(`Group '${entry.group}' must have at least 2 stages${context}`);
      }
      for (const s of entry.stages) {
        validateStageFields(s, context);
      }
      stages.push({
        group: entry.group,
        max_iterations: entry.max_iterations ?? 3,
        stages: entry.stages,
      } as StageGroup);
    } else {
      // Simple stage
      validateStageFields(entry, context);
      stages.push(entry as StageDefinition);
    }
  }

  // Parse on_pipeline_start commands
  let on_pipeline_start: import('@studio/contracts').StartupCommand[] | undefined;
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

function validateStageFields(stage: any, context: string): void {
  if (!stage.name) throw new Error(`Stage missing 'name'${context}`);
  if (!stage.kind) throw new Error(`Stage '${stage.name}' missing 'kind'${context}`);
  if (!stage.agent) throw new Error(`Stage '${stage.name}' missing 'agent'${context}`);
}
