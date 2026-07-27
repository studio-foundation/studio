// runner/src/integrations/integration-loader.ts
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import type { IntegrationPluginDef } from '@studio-foundation/contracts';
import { BUNDLED_ASSETS } from '../generated/bundled-assets.js';

const INTEGRATION_TEMPLATE_PREFIX = 'integrations/';
const INTEGRATION_TEMPLATE_SUFFIX = '.integration.yaml';

/**
 * Return the raw YAML content of a bundled integration template by name.
 * Returns null if the integration does not exist in the bundled registry.
 */
export function getBundledIntegrationTemplate(name: string): string | null {
  return (
    BUNDLED_ASSETS[`${INTEGRATION_TEMPLATE_PREFIX}${name}${INTEGRATION_TEMPLATE_SUFFIX}`] ?? null
  );
}

/**
 * List all integration plugins available for installation from the bundled registry.
 * Returns an array of { name, description } objects.
 */
export function listAvailableIntegrationTemplates(): { name: string; description: string }[] {
  return Object.keys(BUNDLED_ASSETS)
    .filter(
      key =>
        key.startsWith(INTEGRATION_TEMPLATE_PREFIX) && key.endsWith(INTEGRATION_TEMPLATE_SUFFIX)
    )
    .sort()
    .map(key => ({
      name: key.slice(INTEGRATION_TEMPLATE_PREFIX.length, -INTEGRATION_TEMPLATE_SUFFIX.length),
      description: (yaml.load(BUNDLED_ASSETS[key]) as IntegrationPluginDef).description ?? '',
    }));
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
