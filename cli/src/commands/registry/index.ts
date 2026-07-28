import { Command } from 'commander';
import { searchCommand, browseCommand } from './search.js';
import { installCommand } from './install.js';
import { removeCommand } from './remove.js';
import { updateCommand, outdatedCommand } from './update.js';
import { publishCommand } from './publish.js';
import { auditCommand } from './audit.js';
import { syncRegistry } from './sync.js';

export function createRegistryCommand(): Command {
  const registry = new Command('registry')
    .description('Manage community registry packages');

  registry
    .command('search <query>')
    .description('Search packages in the registry')
    .option('--type <type>', 'Filter by packaging type (template, plugin) or content kind (tool, agent, skill, trigger, pipeline, contract, input)')
    .action((query: string, options: { type?: string }) => searchCommand(query, options));

  registry
    .command('browse')
    .description('Browse most popular packages')
    .action(() => browseCommand());

  registry
    .command('install <name>')
    .description('Install a package (use name@version for a specific version)')
    .option('--force', 'Reinstall even if already installed')
    .action((name: string, options: { force?: boolean }) => installCommand(name, options));

  registry
    .command('remove <name>')
    .description('Uninstall a package')
    .action((name: string) => removeCommand(name));

  registry
    .command('update <name>')
    .description('Update an installed package to the highest version its dependents accept')
    .option('--latest', 'Update to the latest published version, even if it breaks a declared range')
    .action((name: string, options: { latest?: boolean }) => updateCommand(name, options));

  registry
    .command('outdated')
    .description('List packages with available updates')
    .action(() => outdatedCommand());

  registry
    .command('publish <path>')
    .description('Publish a package to the community registry via GitHub PR')
    .option('--dry-run', 'Validate only, do not create PR')
    .action((path: string, options: { dryRun?: boolean }) => publishCommand(path, options));

  registry
    .command('audit')
    .description('Verify SHA256 integrity of installed packages')
    .action(() => auditCommand());

  registry
    .command('sync')
    .description('Force refresh the registry index cache')
    .action(() => syncRegistry({ force: true }));

  return registry;
}
