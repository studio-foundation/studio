// Load and parse output contracts from YAML
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import type { OutputContract } from '@studio/contracts';

export async function loadContract(path: string): Promise<OutputContract> {
  const content = await readFile(path, 'utf-8');
  return parseContract(content);
}

export function parseContract(yamlContent: string): OutputContract {
  const parsed = yaml.load(yamlContent) as OutputContract;

  // Validation basique
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid contract: expected object');
  }

  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error('Invalid contract: missing or invalid name');
  }

  if (parsed.version === undefined || typeof parsed.version !== 'number') {
    throw new Error('Invalid contract: missing or invalid version');
  }

  return parsed;
}
