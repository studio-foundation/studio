import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import * as yaml from 'js-yaml';
import { getBundledIntegrationTemplate, listAvailableIntegrationTemplates, loadProjectIntegrations } from '@studio/runner';
import type { IntegrationPluginDef } from '@studio/contracts';
import { loadConfig, resolveEnvVars } from '../config.js';

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
      case 'remove':
      case 'test':
      case 'set':
        throw new Error(`Not implemented yet: ${action}`);
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
