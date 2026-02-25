import { readdir, readFile, writeFile, unlink, mkdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { checkbox } from '@inquirer/prompts';
import { loadConfig } from '../config.js';
import { listAvailableToolTemplates, getBundledToolTemplate } from '@studio/runner';

export function getToolsDir(studioDir: string): string {
  return resolve(studioDir, 'tools');
}

export async function toolsAddDirect(
  studioDir: string,
  toolNames: string[]
): Promise<{ installed: string[]; skipped: string[] }> {
  const toolsDir = getToolsDir(studioDir);
  await mkdir(toolsDir, { recursive: true });

  const installed: string[] = [];
  const skipped: string[] = [];

  for (const name of toolNames) {
    const templateContent = await getBundledToolTemplate(name);
    if (!templateContent) {
      const available = await listAvailableToolTemplates();
      throw new Error(`Unknown tool '${name}'. Available: ${available.map((t) => t.name).join(', ')}`);
    }

    const destPath = resolve(toolsDir, `${name}.tool.yaml`);
    const alreadyInstalled = await access(destPath).then(() => true).catch(() => false);
    if (alreadyInstalled) {
      skipped.push(name);
      continue;
    }

    await writeFile(destPath, templateContent, 'utf-8');
    installed.push(name);
  }

  return { installed, skipped };
}

export async function listTools(toolsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(toolsDir);
    return entries
      .filter((f) => f.endsWith('.tool.yaml'))
      .map((f) => f.replace('.tool.yaml', ''))
      .sort();
  } catch {
    return [];
  }
}

async function resolveToolsDir(): Promise<string> {
  const config = await loadConfig();
  const studioDir = config.resolvedStudioDir;

  if (!studioDir) {
    console.error("Error: No .studio/ directory found. Run 'studio init' first.");
    process.exit(1);
  }

  return getToolsDir(studioDir);
}

export async function toolsCommand(
  action: string,
  args: string[]
): Promise<void> {
  try {
    switch (action) {
      case 'list': {
        const config = await loadConfig();
        const studioDir = config.resolvedStudioDir;
        if (!studioDir) {
          console.error("Error: No .studio/ directory found. Run 'studio init' first.");
          process.exit(1);
        }
        const toolsDir = getToolsDir(studioDir);
        const tools = await listTools(toolsDir);

        if (tools.length === 0) {
          console.log(chalk.yellow('No tools installed.'));
          console.log('  Run: studio tools add <name>');
        } else {
          console.log('\nInstalled tools:');
          for (const t of tools) {
            console.log(`  - ${t}`);
          }
        }

        // Show installed plugins (from .studio/plugins/)
        const { loadPlugins: loadPluginManifests } = await import('@studio/runner');
        const pluginsDir = resolve(studioDir, 'plugins');
        const manifests = await loadPluginManifests(pluginsDir);
        if (manifests.length > 0) {
          console.log('\nInstalled plugins:');
          for (const m of manifests) {
            const serverNames = Object.keys(m.mcpServers);
            const skillCount = m.skills.length;
            const parts: string[] = [];
            if (serverNames.length > 0) parts.push(`MCP: ${serverNames.join(', ')}`);
            if (skillCount > 0) parts.push(`${skillCount} skill${skillCount !== 1 ? 's' : ''}`);
            console.log(`  - ${m.name}${parts.length > 0 ? ` (${parts.join('; ')})` : ''}`);
          }
        }
        console.log('');
        break;
      }

      case 'add': {
        if (args.length === 0) {
          // Wizard mode
          const config = await loadConfig();
          const studioDir = config.resolvedStudioDir;
          if (!studioDir) {
            console.error("Error: No .studio/ directory found. Run 'studio init' first.");
            process.exit(1);
          }

          console.log('');
          const available = await listAvailableToolTemplates();
          const alreadyInstalled = await listTools(getToolsDir(studioDir));

          const choices = available.map((t) => ({
            value: t.name,
            name: `${t.name} — ${t.description}`,
            disabled: alreadyInstalled.includes(t.name) ? '(already installed)' : false,
          }));

          const selected: string[] = await checkbox({
            message: 'Select tools to install:',
            choices,
          });

          if (selected.length === 0) {
            console.log('No tools selected.');
            break;
          }

          console.log('\nInstalling tools...');
          const { installed, skipped } = await toolsAddDirect(studioDir, selected);

          for (const name of installed) {
            console.log(chalk.green(`  ✓ ${name}.tool.yaml`));
          }
          for (const name of skipped) {
            console.log(chalk.yellow(`  ⚠ ${name} already installed, skipping`));
          }
          console.log('');
          console.log(`Done! ${installed.length} tool${installed.length !== 1 ? 's' : ''} installed.`);
          break;
        }

        // Direct mode
        const config = await loadConfig();
        const studioDir = config.resolvedStudioDir!;

        const { installed, skipped } = await toolsAddDirect(studioDir, args);

        for (const name of installed) {
          console.log(chalk.green(`  ✓ ${name}.tool.yaml`));
        }
        for (const name of skipped) {
          console.log(chalk.yellow(`  ⚠ ${name} already installed, skipping`));
        }
        console.log('');
        if (installed.length > 0) {
          console.log(`Done! ${installed.length} tool${installed.length > 1 ? 's' : ''} installed.`);
        } else {
          console.log('No new tools installed.');
        }
        break;
      }

      case 'remove': {
        const name = args[0];
        if (!name) {
          console.error('Usage: studio tools remove <name>');
          process.exit(1);
        }
        const toolsDir = await resolveToolsDir();
        const toolPath = resolve(toolsDir, `${name}.tool.yaml`);
        try {
          await unlink(toolPath);
          console.log(chalk.green(`✓ Removed tool '${name}'`));
        } catch {
          console.error(`Error: Tool '${name}' not found`);
          process.exit(1);
        }
        break;
      }

      case 'info': {
        const name = args[0];
        if (!name) {
          console.error('Usage: studio tools info <name>');
          process.exit(1);
        }
        const toolsDir = await resolveToolsDir();
        const toolPath = resolve(toolsDir, `${name}.tool.yaml`);
        try {
          const content = await readFile(toolPath, 'utf-8');
          console.log(content);
        } catch {
          console.error(`Error: Tool '${name}' not found.`);
          process.exit(1);
        }
        break;
      }

      default:
        console.error(
          `Unknown tools action: ${action}. Available: list, add, remove, info`
        );
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
