import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'node:path';
import { installCommand } from './registry/install.js';
import { removeCommand } from './registry/remove.js';
import { RegistryLockfile } from '../registry/lockfile.js';
import { findStudioDir } from '../studio-dir.js';

async function listCommand(): Promise<void> {
  const studioDir = await findStudioDir(process.cwd()) ?? resolve(process.cwd(), '.studio');
  const installed = (await new RegistryLockfile(studioDir).list())
    .filter((entry) => entry.type !== 'template');

  if (installed.length === 0) {
    console.log(chalk.gray('No plugins installed.'));
    return;
  }
  for (const entry of installed) {
    console.log(`  ${chalk.bold(entry.name)} ${chalk.gray(`v${entry.version}`)}`);
  }
}

/**
 * `studio plugin add` is the documented verb for adding to an existing `.studio/`
 * (ADR 0002); `studio registry install` stays as the name muscle memory and older
 * docs use.
 */
export function createPluginCommand(): Command {
  const plugin = new Command('plugin').description('Add plugins to an existing project');

  plugin
    .command('add <name>')
    .description('Install a plugin (use name@version for a specific version)')
    .option('--force', 'Reinstall even if already installed')
    .action((name: string, options: { force?: boolean }) => installCommand(name, options));

  plugin
    .command('remove <name>')
    .description('Uninstall a plugin')
    .action((name: string) => removeCommand(name));

  plugin
    .command('list')
    .description('List installed plugins')
    .action(() => listCommand());

  return plugin;
}
