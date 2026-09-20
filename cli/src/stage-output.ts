import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { StageRun } from '@studio-foundation/contracts';

export interface StageOutputTarget {
  /** null means the last stage of the run */
  stage: string | null;
  path: string;
}

export function parseStageOutputSpec(spec: string): StageOutputTarget {
  const eq = spec.indexOf('=');
  if (eq <= 0 || eq === spec.length - 1) {
    throw new Error(`Invalid --stage-output "${spec}": expected <stage>=<path>`);
  }
  return { stage: spec.slice(0, eq), path: spec.slice(eq + 1) };
}

export function buildStageOutputTargets(
  outputFile: string | undefined,
  stageOutputs: string[] | undefined
): StageOutputTarget[] {
  const targets = (stageOutputs ?? []).map(parseStageOutputSpec);
  if (outputFile) targets.push({ stage: null, path: outputFile });
  return targets;
}

/**
 * Write stage outputs from this run's in-memory result, never from the run
 * log: two concurrent runs of the same pipeline share a log directory.
 * Returns the stage names that had no output to write.
 */
export async function writeStageOutputs(
  stages: StageRun[],
  targets: StageOutputTarget[],
  redact: (text: string) => string
): Promise<string[]> {
  const missing: string[] = [];
  for (const { stage, path } of targets) {
    const found = stage === null ? stages[stages.length - 1] : stages.find((s) => s.stage_name === stage);
    if (found?.output === undefined) {
      missing.push(stage ?? '(last stage)');
      continue;
    }
    const file = resolve(path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, redact(JSON.stringify(found.output, null, 2)) + '\n');
  }
  return missing;
}
