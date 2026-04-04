// Load agent profiles from YAML files

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { AgentConfig } from '@studio/contracts';

export async function loadAgentProfile(
  name: string,
  agentsDir: string
): Promise<AgentConfig> {
  const path = join(agentsDir, `${name}.agent.yaml`);

  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to load agent profile '${name}' at ${path}: ${(err as Error).message}`);
  }

  return parseAgentYaml(content, path);
}

export function parseAgentYaml(yamlContent: string, sourcePath?: string): AgentConfig {
  const parsed = yaml.load(yamlContent) as Record<string, unknown>;
  const context = sourcePath ? ` (from ${sourcePath})` : '';

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid agent YAML: expected an object${context}`);
  }

  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error(`Agent config missing required field 'name'${context}`);
  }

  // provider and model are optional — defaults are applied at execution time

  return parsed as unknown as AgentConfig;
}
