// "This stage runs unvalidated" — the startup warning for stages with no
// `contract:` (STU-703).
//
// A contract-less stage is legitimate, so this is a warning and stays one: it
// never changes an exit code or a stage status. It exists because the silence
// was indistinguishable from validation being in force — which is how three
// official templates shipped contracts no stage referenced.

import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PipelineDefinition } from '@studio-foundation/contracts';
import {
  loadPipeline,
  findUnvalidatedStagesInPipeline,
  formatUnvalidatedStages,
} from '@studio-foundation/engine';
import type { UnvalidatedStage } from '@studio-foundation/engine';
import type { StudioConfig } from './config.js';

const PIPELINE_SUFFIX = '.pipeline.yaml';

export const SUPPRESS_HINT =
  'Add a `contract:` to each, or set `warnings.missing_contract: false` in .studio/config.yaml to silence this.';

/** False only when the project explicitly opted out. */
export function missingContractWarningsEnabled(config: StudioConfig): boolean {
  return config.warnings?.missing_contract !== false;
}

/** One warning line per contract-less stage of a pipeline about to run. */
export function missingContractWarnings(pipeline: PipelineDefinition): string[] {
  return formatUnvalidatedStages(findUnvalidatedStagesInPipeline(pipeline));
}

/** The `.studio/pipelines/` directory this config points at. */
export function resolvePipelinesDir(studioDir: string, config: StudioConfig): string {
  const configsDir = config.paths?.configs ? resolve(config.paths.configs) : studioDir;
  return join(configsDir, 'pipelines');
}

export interface PipelineCoverage {
  /** Pipeline files read, whatever their coverage. */
  scanned: number;
  /** Files that could not be read or parsed — `studio run` fails on them anyway. */
  unreadable: string[];
  /** Unvalidated stages, tagged with the pipeline they came from. */
  stages: Array<UnvalidatedStage & { pipeline: string }>;
}

/**
 * Contract coverage across every pipeline in a directory. Never throws: a
 * pipeline that fails to load is counted as unreadable, not fatal — `studio
 * doctor` reports, it does not gate.
 */
export async function scanPipelineContracts(pipelinesDir: string): Promise<PipelineCoverage> {
  let entries: string[];
  try {
    entries = (await readdir(pipelinesDir)).filter((f) => f.endsWith(PIPELINE_SUFFIX)).sort();
  } catch {
    return { scanned: 0, unreadable: [], stages: [] };
  }

  const coverage: PipelineCoverage = { scanned: 0, unreadable: [], stages: [] };
  for (const file of entries) {
    let pipeline: PipelineDefinition;
    try {
      pipeline = await loadPipeline(join(pipelinesDir, file));
    } catch {
      coverage.unreadable.push(file);
      continue;
    }
    coverage.scanned++;
    for (const stage of findUnvalidatedStagesInPipeline(pipeline)) {
      coverage.stages.push({ ...stage, pipeline: pipeline.name });
    }
  }
  return coverage;
}

/** `pipeline 'x', stage 'y' (in group 'z')` — the doctor listing form. */
export function formatCoverageEntry(entry: UnvalidatedStage & { pipeline: string }): string {
  return `pipeline '${entry.pipeline}', stage '${entry.stage}'${entry.group ? ` (in group '${entry.group}')` : ''}`;
}
