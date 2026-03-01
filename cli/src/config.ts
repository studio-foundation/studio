import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import yaml from 'js-yaml';
import { findStudioDir } from './studio-dir.js';

export interface StudioConfig {
  providers?: {
    openai?: { apiKey: string };
    anthropic?: { apiKey: string };
  };
  paths?: {
    configs?: string;
    projects_dir?: string;
    pipelines?: string;
  };
  defaults?: {
    provider?: string;
    model?: string;
  };
  api?: {
    key?: string;
    port?: number;
  };
  integrations?: Record<string, Record<string, unknown>>;
  db?: {
    type?: 'sqlite' | 'postgres' | 'inmemory';
    url?: string;   // required when type is 'postgres'
  };
  /** Resolved path to .studio/ dir — set at load time, not from YAML */
  resolvedStudioDir?: string;
}

const LEGACY_CONFIG_NAMES = ['.studiorc.yaml', '.studiorc.yml'];

export async function loadConfig(configPath?: string, cwd?: string): Promise<StudioConfig> {
  const effectiveCwd = cwd ?? process.cwd();

  if (configPath) {
    return loadFromFile(resolve(configPath));
  }

  // 1. Try .studio/config.yaml (new standard)
  const studioDir = await findStudioDir(effectiveCwd);
  if (studioDir) {
    const studioConfig = join(studioDir, 'config.yaml');
    try {
      const config = await loadFromFile(studioConfig);
      config.resolvedStudioDir = studioDir;
      return config;
    } catch {
      // .studio/ exists but no config.yaml — still set studioDir for path resolution
      return { resolvedStudioDir: studioDir };
    }
  }

  // 2. Fallback: .studiorc.yaml / .studiorc.yml at cwd
  for (const name of LEGACY_CONFIG_NAMES) {
    const filePath = resolve(effectiveCwd, name);
    try {
      return await loadFromFile(filePath);
    } catch {
      // try next
    }
  }

  return {};
}

async function loadFromFile(filePath: string): Promise<StudioConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`Config file not found: ${filePath}`);
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

export function resolveEnvVars(content: string): string {
  return content.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const value = process.env[varName.trim()];
    return value === undefined ? '' : value;
  });
}
