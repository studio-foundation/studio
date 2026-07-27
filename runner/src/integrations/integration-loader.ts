// runner/src/integrations/integration-loader.ts
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import type { IntegrationPluginDef } from '@studio-foundation/contracts';

/**
 * Load all `.integration.yaml` files from a project's integrations directory.
 * Returns an empty array if the directory does not exist.
 */
export async function loadProjectIntegrations(integrationsDir: string): Promise<IntegrationPluginDef[]> {
  if (!existsSync(integrationsDir)) return [];

  let files: string[];
  try {
    files = (await readdir(integrationsDir)).filter(f => f.endsWith('.integration.yaml'));
  } catch {
    return [];
  }

  const result: IntegrationPluginDef[] = [];
  for (const file of files.sort()) {
    const content = await readFile(resolve(integrationsDir, file), 'utf-8');
    result.push(yaml.load(content) as IntegrationPluginDef);
  }
  return result;
}
