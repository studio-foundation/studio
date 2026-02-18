import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

export interface StudioConfig {
  providers?: {
    openai?: { apiKey: string };
    anthropic?: { apiKey: string };
  };
  paths?: {
    configs?: string;
    projects_dir?: string;
  };
  defaults?: {
    provider?: string;
    model?: string;
  };
}

const DEFAULT_CONFIG_NAMES = ['.studiorc.yaml', '.studiorc.yml'];

export async function loadConfig(configPath?: string): Promise<StudioConfig> {
  const filePath = configPath ? resolve(configPath) : await findConfig();

  if (!filePath) {
    return {};
  }

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    if (configPath) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    return {};
  }

  const resolved = resolveEnvVars(raw);

  let parsed: unknown;
  try {
    parsed = yaml.load(resolved);
  } catch (err) {
    throw new Error(
      `Failed to parse config ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    return {};
  }

  return parsed as StudioConfig;
}

async function findConfig(): Promise<string | null> {
  for (const name of DEFAULT_CONFIG_NAMES) {
    const filePath = resolve(process.cwd(), name);
    try {
      await readFile(filePath, 'utf-8');
      return filePath;
    } catch {
      // Not found, try next
    }
  }
  return null;
}

export function resolveEnvVars(content: string): string {
  return content.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const value = process.env[varName.trim()];
    if (value === undefined) {
      return '';
    }
    return value;
  });
}
