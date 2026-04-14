// Load output contracts from YAML files

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { OutputContract } from '@studio-foundation/contracts';

export async function loadContract(
  name: string,
  contractsDir: string
): Promise<OutputContract> {
  const path = join(contractsDir, `${name}.contract.yaml`);

  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to load contract '${name}' at ${path}: ${(err as Error).message}`);
  }

  return parseContractYaml(content, path);
}

export function parseContractYaml(yamlContent: string, sourcePath?: string): OutputContract {
  const parsed = yaml.load(yamlContent) as Record<string, unknown>;
  const context = sourcePath ? ` (from ${sourcePath})` : '';

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid contract YAML: expected an object${context}`);
  }

  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error(`Contract missing required field 'name'${context}`);
  }

  if (parsed.version === undefined) {
    throw new Error(`Contract missing required field 'version'${context}`);
  }

  return parsed as unknown as OutputContract;
}
