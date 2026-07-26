import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { resolveEnvVars } from '@studio-foundation/engine';

export const CONFIG_FILE = 'config.yaml';
export const CONFIG_EXAMPLE_FILE = 'config.example.yaml';

export type ConfigCheckStatus = 'ok' | 'no-contract' | 'missing-config' | 'missing-keys';

export interface ConfigCheckResult {
  status: ConfigCheckStatus;
  /** Dotted key paths declared in the example but absent from config.yaml */
  missingKeys: string[];
  configPath: string;
  examplePath: string;
}

/**
 * Dotted paths of every leaf declared in a parsed config document.
 * An empty object (`ollama: {}`) is a leaf — the key itself is the declaration.
 */
export function leafKeyPaths(doc: unknown, prefix = ''): string[] {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return prefix ? [prefix] : [];
  }
  const entries = Object.entries(doc as Record<string, unknown>);
  if (entries.length === 0) {
    return prefix ? [prefix] : [];
  }
  return entries.flatMap(([key, value]) =>
    leafKeyPaths(value, prefix ? `${prefix}.${key}` : key)
  );
}

function hasKeyPath(doc: unknown, path: string): boolean {
  let current: unknown = doc;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
    if (!(segment in (current as Record<string, unknown>))) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

async function loadYamlFile(path: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return null;
  }
  return yaml.load(resolveEnvVars(raw)) ?? {};
}

/**
 * Validate `.studio/config.yaml` against `.studio/config.example.yaml`.
 *
 * The example IS the contract: every key left uncommented there is required in
 * config.yaml. A project without an example declares no contract and is never
 * blocked.
 */
export async function checkConfig(studioDir: string): Promise<ConfigCheckResult> {
  const configPath = join(studioDir, CONFIG_FILE);
  const examplePath = join(studioDir, CONFIG_EXAMPLE_FILE);

  const example = await loadYamlFile(examplePath);
  if (example === null) {
    return { status: 'no-contract', missingKeys: [], configPath, examplePath };
  }

  const config = await loadYamlFile(configPath);
  if (config === null) {
    return { status: 'missing-config', missingKeys: [], configPath, examplePath };
  }

  const missingKeys = leafKeyPaths(example).filter((path) => !hasKeyPath(config, path));

  return {
    status: missingKeys.length > 0 ? 'missing-keys' : 'ok',
    missingKeys,
    configPath,
    examplePath,
  };
}

/** Human-facing error text for a failed check, or null when the check passed. */
export function formatConfigCheckError(result: ConfigCheckResult): string | null {
  if (result.status === 'missing-config') {
    return (
      `Error: ${result.configPath} not found, but ${CONFIG_EXAMPLE_FILE} declares a config contract.\n` +
      `  Create it: cp ${result.examplePath} ${result.configPath}`
    );
  }
  if (result.status === 'missing-keys') {
    const keys = result.missingKeys.map((k) => `  - ${k}`).join('\n');
    return (
      `Error: ${result.configPath} is missing required key${result.missingKeys.length > 1 ? 's' : ''}:\n` +
      `${keys}\n` +
      `  See ${result.examplePath} for the full contract.`
    );
  }
  return null;
}
