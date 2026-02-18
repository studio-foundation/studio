import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import * as yaml from 'js-yaml';
import chalk from 'chalk';
import { findStudioDir } from '../studio-dir.js';
import { resolveEnvVars } from '../config.js';

export const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic (Claude)', defaultModel: 'claude-sonnet-4-20250514' },
  { id: 'openai',    label: 'OpenAI (GPT)',        defaultModel: 'gpt-4o' },
  { id: 'google',    label: 'Google (Gemini)',     defaultModel: 'gemini-1.5-pro' },
  { id: 'local',     label: 'Local (Ollama)',      defaultModel: 'llama3.2' },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]['id'];

export function validateApiKeyForProvider(provider: string, key: string): true | string {
  if (provider === 'anthropic') {
    if (!key.startsWith('sk-ant-')) return 'Anthropic API keys must start with sk-ant-';
  } else if (provider === 'openai') {
    if (!key.startsWith('sk-') || key.startsWith('sk-ant-'))
      return 'OpenAI API keys must start with sk- (and not be an Anthropic key)';
  } else if (provider === 'google') {
    if (!key.startsWith('AIza')) return 'Google API keys must start with AIza';
  }
  // local / unknown providers: no format constraint
  return true;
}

export function getConfigValue(config: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = config;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function setConfigValue(config: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split('.');
  let current = config;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

export function maskSecrets(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(maskSecrets);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => {
        if (k.toLowerCase() === 'apikey' && typeof v === 'string') {
          const prefix = v.slice(0, 3);
          return [k, `${prefix}***...`];
        }
        return [k, maskSecrets(v)];
      })
    );
  }
  return obj;
}

async function resolveConfigFilePath(): Promise<string> {
  const studioDir = await findStudioDir(process.cwd());
  if (studioDir) return join(studioDir, 'config.yaml');
  // Create .studio/ at cwd if nothing found
  const newStudioDir = resolve(process.cwd(), '.studio');
  await mkdir(newStudioDir, { recursive: true });
  return join(newStudioDir, 'config.yaml');
}

async function loadRawConfig(configFile: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configFile, 'utf-8');
    const parsed = yaml.load(resolveEnvVars(raw));
    return (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function saveConfig(configFile: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, yaml.dump(config), 'utf-8');
}

interface ConfigOptions {
  apiKey?: string;
  project?: string;
}

export async function configCommand(
  action: string,
  args: string[],
  options: ConfigOptions
): Promise<void> {
  try {
    const configFile = await resolveConfigFilePath();

    switch (action) {
      case 'list': {
        const config = await loadRawConfig(configFile);
        const masked = maskSecrets(config);
        console.log('');
        console.log(chalk.bold('Studio Configuration:'));
        console.log(chalk.gray(`  File: ${configFile}`));
        console.log('');
        console.log(yaml.dump(masked));
        break;
      }

      case 'get': {
        const path = args[0];
        if (!path) {
          console.error('Usage: studio config get <dotted.path>');
          process.exit(1);
        }
        const config = await loadRawConfig(configFile);
        const value = getConfigValue(config, path);
        if (value === undefined) {
          console.log(chalk.yellow(`(not set)`));
        } else {
          console.log(String(value));
        }
        break;
      }

      case 'set': {
        const config = await loadRawConfig(configFile);

        // Convenience: studio config set provider <name> --api-key <key>
        if (args[0] === 'provider' && args[1] && options.apiKey) {
          const providerName = args[1];
          setConfigValue(config, `providers.${providerName}.apiKey`, options.apiKey);
          await saveConfig(configFile, config);
          console.log(chalk.green(`✓ Set providers.${providerName}.apiKey`));
          break;
        }

        // Generic: studio config set <dotted.path> <value>
        const path = args[0];
        const value = args[1];
        if (!path || value === undefined) {
          console.error('Usage: studio config set <dotted.path> <value>');
          console.error('       studio config set provider <name> --api-key <key>');
          process.exit(1);
        }
        setConfigValue(config, path, value);
        await saveConfig(configFile, config);
        console.log(chalk.green(`✓ Set ${path} = ${value}`));
        break;
      }

      default:
        console.error(`Unknown config action: ${action}. Available: list, get, set`);
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
