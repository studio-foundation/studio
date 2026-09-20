import { access, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { FieldSpec, OutputContract, PipelineEntry, PipelineDefinition } from '@studio-foundation/contracts';
import { loadContract, loadPipeline } from '@studio-foundation/engine';

export interface MockStageSkeleton {
  output: Record<string, unknown>;
  tool_calls: Array<{ name: string; arguments: Record<string, unknown> }>;
}

const FALLBACK_TOOL = 'repo_manager-list_files';

function placeholder(spec: FieldSpec | undefined): unknown {
  if (spec?.enum?.length) return spec.enum[0];
  switch (spec?.type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return spec.items ? [placeholder(spec.items)] : [];
    case 'object':
      return objectPlaceholder(spec.required_fields, spec.fields);
    default:
      return 'mock';
  }
}

function objectPlaceholder(
  required: string[] | undefined,
  fields: Record<string, FieldSpec> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of required ?? []) out[name] = placeholder(fields?.[name]);
  return out;
}

function toolName(contractName: string): string {
  return contractName.replace('.', '-');
}

/** A mock.yaml entry that satisfies the contract's schema and tool-call floor. */
export function buildMockSkeleton(contract: OutputContract): MockStageSkeleton {
  const output = objectPlaceholder(contract.schema?.required_fields, contract.schema?.fields);

  const calls = contract.tool_calls;
  const names = [
    ...(calls?.required_tools ?? []),
    ...(calls?.required_tool_groups ?? []).map((group) => group[0]),
  ].map(toolName);
  const missing = Math.max((calls?.minimum ?? 0) - names.length, 0);
  for (let i = 0; i < missing; i++) names.push(FALLBACK_TOOL);

  return { output, tool_calls: names.map((name) => ({ name, arguments: {} })) };
}

function contractNames(pipeline: PipelineDefinition): string[] {
  const names: string[] = [];
  const visit = (entry: PipelineEntry): void => {
    if ('stages' in entry) entry.stages.forEach(visit);
    else if ('contract' in entry && entry.contract) names.push(entry.contract);
  };
  pipeline.stages.forEach(visit);
  return names;
}

/**
 * Writes `<studioDir>/mock.yaml` with one entry per contract a pipeline stage
 * references. An existing file is never touched. Returns whether it wrote.
 */
export async function writeMockSkeleton(studioDir: string): Promise<boolean> {
  const target = join(studioDir, 'mock.yaml');
  if (await access(target).then(() => true, () => false)) return false;

  const pipelinesDir = join(studioDir, 'pipelines');
  const files = await readdir(pipelinesDir).catch(() => [] as string[]);
  const names = new Set<string>();
  for (const file of files.filter((f) => f.endsWith('.pipeline.yaml')).sort()) {
    for (const name of contractNames(await loadPipeline(join(pipelinesDir, file)))) names.add(name);
  }
  if (names.size === 0) return false;

  const stages: Record<string, MockStageSkeleton> = {};
  for (const name of names) {
    stages[name] = buildMockSkeleton(await loadContract(name, join(studioDir, 'contracts')));
  }
  await writeFile(target, yaml.dump({ stages }, { lineWidth: -1 }), 'utf-8');
  return true;
}
