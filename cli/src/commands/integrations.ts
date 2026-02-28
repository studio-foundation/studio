import { readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import * as yaml from 'js-yaml';
import { getBundledIntegrationTemplate, listAvailableIntegrationTemplates, loadProjectIntegrations } from '@studio/runner';
import type { IntegrationPluginDef } from '@studio/contracts';
import { loadConfig, resolveEnvVars } from '../config.js';
import { setConfigValue } from './config.js';

export function getIntegrationsDir(studioDir: string): string {
  return resolve(studioDir, 'integrations');
}

export function getIntegrationStatus(
  plugin: IntegrationPluginDef,
  config: Record<string, unknown>
): 'configured' | 'not-configured' {
  const required = plugin.config?.required ?? [];
  const allSet = required.every(key => key in config && config[key] !== '');
  return allSet ? 'configured' : 'not-configured';
}

async function loadRawIntegrationsConfig(studioDir: string): Promise<Record<string, Record<string, unknown>>> {
  const configFile = join(studioDir, 'config.yaml');
  try {
    const raw = await readFile(configFile, 'utf-8');
    const parsed = yaml.load(resolveEnvVars(raw)) as Record<string, unknown>;
    return (parsed?.['integrations'] ?? {}) as Record<string, Record<string, unknown>>;
  } catch {
    return {};
  }
}

function formatExtras(plugin: IntegrationPluginDef, config: Record<string, unknown>): string {
  if (plugin.name === 'linear') {
    const autoTrigger = config['autoTrigger'] ?? plugin.config?.optional?.['autoTrigger'] ?? false;
    return `auto-trigger: ${autoTrigger ? 'on' : 'off'}`;
  }
  if (plugin.name === 'slack') {
    const channel = config['channel'] ?? plugin.config?.optional?.['channel'] ?? '';
    return channel ? `channel: ${String(channel)}` : '';
  }
  return '';
}

async function resolveStudioDir(): Promise<string> {
  const config = await loadConfig();
  const studioDir = config.resolvedStudioDir;
  if (!studioDir) {
    console.error("Error: No .studio/ directory found. Run 'studio init' first.");
    process.exit(1);
  }
  return studioDir;
}

export async function installIntegration(source: string, integrationsDir: string): Promise<string> {
  await mkdir(integrationsDir, { recursive: true });

  let name: string;
  let content: string;

  if (source.startsWith('@studio/integration-')) {
    name = source.replace('@studio/integration-', '');
    const bundled = await getBundledIntegrationTemplate(name);
    if (!bundled) {
      const available = await listAvailableIntegrationTemplates();
      throw new Error(
        `Unknown integration '${name}'. Available: ${available.map(t => t.name).join(', ')}`
      );
    }
    content = bundled;
  } else {
    try {
      content = await readFile(source, 'utf-8');
    } catch {
      throw new Error(`File not found: ${source}`);
    }
    const def = yaml.load(content) as IntegrationPluginDef;
    name = def.name;
  }

  const destPath = join(integrationsDir, `${name}.integration.yaml`);
  const alreadyExists = await access(destPath).then(() => true).catch(() => false);
  if (alreadyExists) {
    throw new Error(
      `'${name}' already installed. Run: studio integrations remove ${name}`
    );
  }

  await writeFile(destPath, content, 'utf-8');
  return name;
}

export async function removeIntegration(name: string, integrationsDir: string): Promise<void> {
  const filePath = join(integrationsDir, `${name}.integration.yaml`);
  try {
    await unlink(filePath);
  } catch {
    throw new Error(`Integration '${name}' not found`);
  }
}

async function loadRawFullConfig(configFile: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configFile, 'utf-8');
    const parsed = yaml.load(resolveEnvVars(raw));
    return (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function saveIntegrationConfig(configFile: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, yaml.dump(config), 'utf-8');
}

export interface IntegrationTestResult {
  success: boolean;
  statusCode?: number;
  body?: string;
  error?: string;
}

export async function runIntegrationTest(
  plugin: IntegrationPluginDef,
  config: Record<string, unknown>,
  fetcher: typeof fetch = fetch
): Promise<IntegrationTestResult> {
  const testDef = plugin.test;
  if (!testDef) {
    throw new Error(`Integration '${plugin.name}' has no test: configuration`);
  }

  const resolveVar = (str: string) =>
    str.replace(/\$\{([^}]+)\}/g, (_, key: string) => String(config[key.trim()] ?? ''));

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (testDef.auth) {
    const resolvedAuth = resolveVar(testDef.auth);
    const colonIdx = resolvedAuth.indexOf(':');
    if (colonIdx !== -1) {
      const scheme = resolvedAuth.slice(0, colonIdx);
      const token = resolvedAuth.slice(colonIdx + 1);
      headers['Authorization'] = `${scheme.charAt(0).toUpperCase()}${scheme.slice(1)} ${token}`;
    }
  }

  try {
    const response = await fetcher(testDef.endpoint, {
      method: testDef.method ?? 'GET',
      headers,
      ...(testDef.body ? { body: testDef.body } : {}),
    });

    const body = await response.text().catch(() => '');
    const expectedStatus = testDef.expect?.status ?? 200;

    if (response.status !== expectedStatus) {
      return { success: false, statusCode: response.status, body };
    }
    return { success: true, statusCode: response.status, body };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function integrationsCommand(
  action: string,
  _args: string[],
  _options: Record<string, string | boolean | undefined>
): Promise<void> {
  try {
    switch (action) {
      case 'install': {
        const source = _args[0];
        if (!source) {
          console.error('Usage: studio integrations install <source>');
          console.error('  <source> can be @studio/integration-<name> or a local file path');
          process.exit(1);
        }
        const studioDir = await resolveStudioDir();
        const intDir = getIntegrationsDir(studioDir);
        const spinner = ora(`Installing ${source}...`).start();
        try {
          const name = await installIntegration(source, intDir);
          spinner.succeed(chalk.green(`✓ Integration '${name}' installed`));
          console.log(`\n  Configure with: ${chalk.cyan(`studio integrations set ${name}.<key> <value>`)}`);
          console.log(`  Test with:      ${chalk.cyan(`studio integrations test ${name}`)}\n`);
        } catch (err) {
          spinner.fail(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
        break;
      }
      case 'list': {
        const studioDir = await resolveStudioDir();
        const intDir = getIntegrationsDir(studioDir);
        const plugins = await loadProjectIntegrations(intDir);

        if (plugins.length === 0) {
          console.log(chalk.yellow('\nNo integrations installed.'));
          console.log(`  Run: ${chalk.cyan('studio integrations install @studio/integration-<name>')}\n`);
          break;
        }

        const config = await loadRawIntegrationsConfig(studioDir);
        console.log('');
        for (const plugin of plugins) {
          const pluginConfig = (config[plugin.name] ?? {}) as Record<string, unknown>;
          const status = getIntegrationStatus(plugin, pluginConfig);
          const dot = status === 'configured' ? chalk.green('●') : chalk.gray('○');
          const statusLabel = status === 'configured'
            ? chalk.green('configured')
            : chalk.gray('not configured');
          const extras = formatExtras(plugin, pluginConfig);
          const version = `v${plugin.version}`;
          console.log(`${plugin.name.padEnd(12)} ${dot} ${statusLabel.padEnd(20)} ${extras.padEnd(20)} ${chalk.gray(version)}`);
        }
        console.log('');
        break;
      }
      case 'remove': {
        const name = _args[0];
        if (!name) {
          console.error('Usage: studio integrations remove <name>');
          process.exit(1);
        }
        const studioDir = await resolveStudioDir();
        await removeIntegration(name, getIntegrationsDir(studioDir));
        console.log(chalk.green(`✓ Integration '${name}' removed`));
        break;
      }
      case 'test': {
        const name = _args[0];
        if (!name) {
          console.error('Usage: studio integrations test <name>');
          process.exit(1);
        }
        const studioDir = await resolveStudioDir();
        const intDir = getIntegrationsDir(studioDir);
        const plugins = await loadProjectIntegrations(intDir);
        const plugin = plugins.find(p => p.name === name);

        if (!plugin) {
          console.error(
            `Error: '${name}' not installed. Run: studio integrations install @studio/integration-${name}`
          );
          process.exit(1);
        }

        if (!plugin.test) {
          console.error(`Error: Integration '${name}' has no test: configuration in its .integration.yaml`);
          process.exit(1);
        }

        const intConfig = await loadRawIntegrationsConfig(studioDir);
        const pluginConfig = intConfig[name] ?? {};
        const required = plugin.config?.required ?? [];
        const missing = required.filter(key => !pluginConfig[key] && !process.env[key]);
        if (missing.length > 0) {
          for (const key of missing) {
            console.error(`Error: ${key} not set. Run: studio integrations set ${name}.${key} <value>`);
          }
          process.exit(1);
        }

        const spinner = ora(`Testing ${name} connection...`).start();
        const result = await runIntegrationTest(plugin, pluginConfig as Record<string, unknown>);

        if (result.success) {
          spinner.succeed(chalk.green(`✓ ${name} connected`));
        } else {
          const detail = result.error ?? `HTTP ${result.statusCode}`;
          spinner.fail(chalk.red(`✗ ${name} error — ${detail}`));
          process.exit(1);
        }
        break;
      }
      case 'set': {
        const dotPath = _args[0];
        const value = _args[1];
        if (!dotPath || value === undefined) {
          console.error('Usage: studio integrations set <name>.<key> <value>');
          process.exit(1);
        }
        const dotIndex = dotPath.indexOf('.');
        if (dotIndex === -1) {
          console.error('Error: path must be <integration-name>.<key> (e.g. linear.autoTrigger)');
          process.exit(1);
        }
        const integrationName = dotPath.slice(0, dotIndex);
        const key = dotPath.slice(dotIndex + 1);

        const studioDir = await resolveStudioDir();
        const intDir = getIntegrationsDir(studioDir);

        const pluginPath = join(intDir, `${integrationName}.integration.yaml`);
        const isInstalled = await access(pluginPath).then(() => true).catch(() => false);
        if (!isInstalled) {
          console.error(
            `Error: Integration '${integrationName}' not installed. ` +
            `Run: studio integrations install @studio/integration-${integrationName}`
          );
          process.exit(1);
        }

        const configFile = join(studioDir, 'config.yaml');
        const rawConfig = await loadRawFullConfig(configFile);
        setConfigValue(rawConfig, `integrations.${integrationName}.${key}`, value);
        await saveIntegrationConfig(configFile, rawConfig);

        console.log(chalk.green(`✓ Set integrations.${integrationName}.${key} = ${value}`));
        break;
      }
      default:
        console.error(`Unknown integrations action: ${action}. Available: install, list, remove, test, set`);
        process.exit(1);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'ExitPromptError') {
      console.log('\nAborted.');
      process.exit(0);
    }
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
