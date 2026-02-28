// runner/src/integrations/integration-loader.ts
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import type { IntegrationPluginDef } from '@studio/contracts';

const BUNDLED_INTEGRATION_TEMPLATES_DIR = resolve(
  __dirname,
  '../../templates/integrations'
);

/**
 * Return the raw YAML content of a bundled integration template by name.
 * Returns null if the integration does not exist in the bundled registry.
 */
export async function getBundledIntegrationTemplate(name: string): Promise<string | null> {
  const filePath = resolve(BUNDLED_INTEGRATION_TEMPLATES_DIR, `${name}.integration.yaml`);
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * List all integration plugins available for installation from the bundled registry.
 * Returns an array of { name, description } objects.
 */
export async function listAvailableIntegrationTemplates(): Promise<{ name: string; description: string }[]> {
  let files: string[];
  try {
    files = (await readdir(BUNDLED_INTEGRATION_TEMPLATES_DIR))
      .filter(f => f.endsWith('.integration.yaml'))
      .sort();
  } catch {
    return [];
  }
  const result: { name: string; description: string }[] = [];
  for (const file of files) {
    const content = await readFile(resolve(BUNDLED_INTEGRATION_TEMPLATES_DIR, file), 'utf-8');
    const def = yaml.load(content) as IntegrationPluginDef;
    result.push({ name: file.replace('.integration.yaml', ''), description: def.description ?? '' });
  }
  return result;
}

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
