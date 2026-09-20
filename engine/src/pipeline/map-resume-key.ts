import { createHash } from 'node:crypto';
import type { MapStage, MapResumeKey, PipelineDefinition } from '@studio-foundation/contracts';
import { isCallStage, isMapStage, isStageGroup } from '@studio-foundation/contracts';
import { loadAgentProfile } from './agent-loader.js';
import { loadContract } from './contract-loader.js';
import { loadPipelineByName } from './loader.js';
import { loadSkillFiles } from './skill-loader.js';
import { loadInvariantsFile } from './invariants-loader.js';
import { canonicalize } from './map-item-cache.js';
import { resolveProjectPaths } from './types.js';

/** `resume: true` and `{ key_on: [input] }` are the same key: the item input alone. */
export function resolveKeyOn(resume: MapStage['resume']): MapResumeKey[] {
  if (resume === undefined || typeof resume === 'boolean') return ['input'];
  return resume.key_on ?? ['input'];
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

async function collectPipelines(
  name: string,
  pipelinesDir: string,
  seen: Map<string, PipelineDefinition>,
): Promise<void> {
  if (seen.has(name)) return;
  const def = await loadPipelineByName(name, pipelinesDir);
  seen.set(name, def);
  for (const entry of def.stages) {
    if (isMapStage(entry)) await collectPipelines(entry.pipeline, pipelinesDir, seen);
    else if (isCallStage(entry)) await collectPipelines(entry.pipeline ?? entry.call, pipelinesDir, seen);
  }
}

/**
 * Fingerprint of what the sub-pipeline's agents and contracts resolve to.
 * Hashes the parsed documents (canonical JSON), so comments and key order do
 * not move it; an agent also folds in its skill bodies and the project
 * invariants, which the prompt is built from. Null when `key_on` names neither.
 */
export async function computeResumeFingerprint(
  keyOn: MapResumeKey[],
  subPipeline: string,
  configsDir: string,
  pluginSkills?: Record<string, string[]>,
): Promise<Record<string, string> | null> {
  const wantAgent = keyOn.includes('agent');
  const wantContract = keyOn.includes('contract');
  if (!wantAgent && !wantContract) return null;

  const paths = resolveProjectPaths(configsDir);
  const pipelines = new Map<string, PipelineDefinition>();
  await collectPipelines(subPipeline, paths.pipelinesDir, pipelines);

  const agents = new Set<string>();
  const contracts = new Set<string>();
  for (const def of pipelines.values()) {
    for (const entry of def.stages) {
      const stages = isStageGroup(entry) ? entry.stages : isMapStage(entry) || isCallStage(entry) ? [] : [entry];
      for (const stage of stages) {
        if (stage.agent) agents.add(stage.agent);
        if (stage.contract) contracts.add(stage.contract.replace('.contract.yaml', ''));
      }
    }
  }

  const fingerprint: Record<string, string> = {};
  if (wantAgent) {
    const invariants = await loadInvariantsFile(paths.projectDir);
    const resolved: Record<string, unknown> = {};
    for (const name of [...agents].sort()) {
      const agent = await loadAgentProfile(name, paths.agentsDir);
      const skills = agent.skills?.length ? await loadSkillFiles(agent.skills, paths.skillsDir) : [];
      const plugins = (agent.plugins ?? []).flatMap((p) => pluginSkills?.[p] ?? []);
      resolved[name] = { agent, skills, plugins, invariants: invariants ?? null };
    }
    fingerprint.agent = hash(resolved);
  }
  if (wantContract) {
    const resolved: Record<string, unknown> = {};
    for (const name of [...contracts].sort()) {
      resolved[name] = await loadContract(name, paths.contractsDir);
    }
    fingerprint.contract = hash(resolved);
  }
  return fingerprint;
}
