import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import * as yaml from 'js-yaml';
import chalk from 'chalk';
import ora from 'ora';
import { select, password, confirm, input } from '@inquirer/prompts';
import { findStudioDir } from '../studio-dir.js';
import { resolveEnvVars } from '../config.js';
import { validateApiKeyLive } from '../provider-validator.js';
import { getAvailableModels } from '../models-cache.js';

export const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic (Claude)', defaultModel: 'claude-sonnet-4-20250514' },
  { id: 'openai',    label: 'OpenAI (GPT)',        defaultModel: 'gpt-4o' },
  { id: 'google',    label: 'Google (Gemini)',     defaultModel: 'gemini-1.5-pro' },
  { id: 'ollama',    label: 'Ollama (local)',      defaultModel: 'llama3.2' },
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
  // ollama / unknown providers: no format constraint
  return true;
}

export async function addProviderConfig(
  configFile: string,
  provider: string,
  apiKey: string,
  setDefault: boolean,
  model?: string
): Promise<void> {
  const config = await loadRawConfig(configFile);

  if (!config.providers || typeof config.providers !== 'object') {
    config.providers = {};
  }
  if (provider === 'ollama') {
    (config.providers as Record<string, unknown>)[provider] = { baseUrl: apiKey };
  } else {
    (config.providers as Record<string, unknown>)[provider] = { apiKey };
  }

  if (setDefault) {
    const meta = PROVIDERS.find((p) => p.id === provider);
    config.defaults = {
      provider,
      model: model ?? meta?.defaultModel ?? 'claude-sonnet-4-20250514',
    };
  }

  await saveConfig(configFile, config);
}

export async function isProviderConfigured(configFile: string, provider: string): Promise<boolean> {
  const config = await loadRawConfig(configFile);
  if (!config.providers || typeof config.providers !== 'object') return false;
  return provider in (config.providers as Record<string, unknown>);
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
  setDefault?: boolean;
}

async function configAddProviderWizard(configFile: string): Promise<void> {
  const config = await loadRawConfig(configFile);
  const existingProviders = config.providers
    ? Object.keys(config.providers as Record<string, unknown>)
    : [];

  // Step 1: Select provider
  const providerId = await select<string>({
    message: 'Which provider would you like to add?',
    choices: PROVIDERS.map((p) => ({ value: p.id, name: p.label })),
  });

  // Step 2: Handle already-configured case
  if (existingProviders.includes(providerId)) {
    const providerLabel = PROVIDERS.find((p) => p.id === providerId)?.label ?? providerId;
    const override = await confirm({
      message: `${providerLabel} is already configured. Override?`,
      default: false,
    });
    if (!override) {
      console.log('Aborted.');
      return;
    }
  }

  // Step 3: Ask for API key (or base URL for ollama)
  let apiKey = '';
  if (providerId === 'ollama') {
    apiKey = await input({
      message: 'Ollama base URL:',
      default: 'http://localhost:11434',
    });
    const spinner = ora('Validating connection...').start();
    const result = await validateApiKeyLive('ollama', '', { baseUrl: apiKey });
    if (result.status === 'valid') spinner.succeed('Connected');
    else if (result.status === 'warning') spinner.warn(result.message);
    else spinner.fail(result.error);
  } else {
    const providerLabel = PROVIDERS.find((p) => p.id === providerId)?.label ?? providerId;
    while (true) {
      apiKey = await password({
        message: `${providerLabel} API Key:`,
        validate: (value: string) => validateApiKeyForProvider(providerId, value),
      });
      const spinner = ora('Validating...').start();
      const result = await validateApiKeyLive(providerId, apiKey);
      spinner.stop();
      if (result.status === 'valid') {
        console.log(chalk.green('  ✓ Valid'));
        break;
      } else if (result.status === 'warning') {
        console.log(chalk.yellow(`  ⚠ ${result.message}`));
        break;
      } else {
        console.log(chalk.red(`  ✗ ${result.error}`));
        console.log(chalk.gray('  Please try again.'));
      }
    }
  }

  // Step 4: Set as default?
  const isFirstProvider = existingProviders.filter((p) => p !== providerId).length === 0;
  const setDefault =
    isFirstProvider ||
    (await confirm({
      message: 'Set as default provider?',
      default: true,
    }));

  // Step 4b: Choose default model (if setting as default and models are available)
  let defaultModel: string | undefined;
  if (setDefault && providerId !== 'ollama') {
    const models = await getAvailableModels(providerId, apiKey);
    const meta = PROVIDERS.find((p) => p.id === providerId);
    const fallbackModel = meta?.defaultModel ?? 'claude-sonnet-4-20250514';

    if (models.length > 0) {
      const choices = [
        ...models.map((m) => ({ value: m, name: m })),
        { value: '__custom__', name: 'Enter custom model ID' },
      ];
      const selected = await select<string>({
        message: 'Default model:',
        choices,
        default: models.includes(fallbackModel) ? fallbackModel : models[0],
      });
      if (selected === '__custom__') {
        defaultModel = await input({ message: 'Model ID:', default: fallbackModel });
      } else {
        defaultModel = selected;
      }
    } else {
      defaultModel = await input({ message: 'Default model:', default: fallbackModel });
    }
  }

  // Step 5: Write config
  await addProviderConfig(configFile, providerId, apiKey, setDefault, defaultModel);

  // Step 6: Confirmation output
  const label = PROVIDERS.find((p) => p.id === providerId)?.label ?? providerId;
  console.log('');
  console.log(chalk.green(`✓ ${label} provider configured`));
  if (setDefault) console.log(chalk.green('✓ Set as default'));
  console.log('');
  console.log('You can now run:');
  console.log(`  ${chalk.cyan('studio run <pipeline> --input "..."')}`);
  console.log('');
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

        // Special case: interactive model selection when no value provided
        if (args[0] === 'defaults.model' && args[1] === undefined) {
          const rawConfig = await loadRawConfig(configFile);
          const defaults = rawConfig.defaults as { provider?: string; model?: string } | undefined;
          const provider = defaults?.provider;
          const providerConfig =
            provider && rawConfig.providers
              ? (rawConfig.providers as Record<string, { apiKey: string }>)[provider]
              : undefined;
          const apiKey = providerConfig?.apiKey ?? '';

          if (!provider) {
            console.error('Error: no default provider configured. Run studio config add-provider first.');
            process.exit(1);
          }

          const spinner = ora(`Fetching models for ${provider}...`).start();
          const models = await getAvailableModels(provider, apiKey);
          spinner.stop();

          if (models.length === 0) {
            console.error(
              `Error: could not fetch models for provider '${provider}'. ` +
              `Provide the model ID directly: studio config set defaults.model <model-id>`
            );
            process.exit(1);
          }

          const selectedModel = await select<string>({
            message: 'Default model:',
            choices: models.map((m) => ({ value: m, name: m })),
            default: defaults?.model && models.includes(defaults.model) ? defaults.model : models[0],
          });

          setConfigValue(rawConfig, 'defaults.model', selectedModel);
          await saveConfig(configFile, rawConfig);
          console.log(chalk.green(`✓ Set defaults.model = ${selectedModel}`));
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

      case 'add-provider': {
        const provider = args[0];

        if (!provider) {
          // Wizard mode
          await configAddProviderWizard(configFile);
          break;
        }

        // Direct mode
        if (provider !== 'ollama' && !options.apiKey) {
          console.error(`Error: --api-key is required for provider '${provider}'`);
          process.exit(1);
        }

        const apiKey = options.apiKey ?? '';

        if (provider !== 'ollama') {
          const validation = validateApiKeyForProvider(provider, apiKey);
          if (validation !== true) {
            console.error(`Error: ${validation}`);
            process.exit(1);
          }
          process.stdout.write('Validating...');
          const result = await validateApiKeyLive(provider, apiKey);
          if (result.status === 'valid') {
            console.log(chalk.green(' ✓ Valid'));
          } else if (result.status === 'warning') {
            console.log(chalk.yellow(` ⚠ ${result.message}`));
          } else {
            console.error(chalk.red(` ✗ ${result.error}`));
            process.exit(1);
          }
        } else {
          process.stdout.write('Validating connection...');
          const result = await validateApiKeyLive('ollama', '', {
            baseUrl: apiKey || 'http://localhost:11434',
          });
          const msg = 'message' in result ? result.message : '';
          if (result.status === 'valid') {
            console.log(chalk.green(' ✓ Connected'));
          } else {
            console.log(chalk.yellow(` ⚠ ${msg}`));
          }
        }

        // Check already configured
        const alreadyConfigured = await isProviderConfigured(configFile, provider);
        if (alreadyConfigured) {
          console.error(
            `Error: Provider '${provider}' is already configured. Use 'studio config set' to update it, or run the wizard to override.`
          );
          process.exit(1);
        }

        // Determine setDefault
        const config = await loadRawConfig(configFile);
        const existingCount = config.providers
          ? Object.keys(config.providers as Record<string, unknown>).length
          : 0;
        const setDefault = options.setDefault ?? existingCount === 0;

        await addProviderConfig(configFile, provider, apiKey, setDefault);

        const label = PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
        console.log(chalk.green(`✓ ${label} provider configured`));
        if (setDefault) console.log(chalk.green('✓ Set as default'));
        console.log('');
        break;
      }

      default:
        console.error(`Unknown config action: ${action}. Available: list, get, set, add-provider`);
        process.exit(1);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'ExitPromptError') {
      console.log('\nAborted.');
      process.exit(0);
    }
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
