import chalk from 'chalk';
import { Command } from 'commander';
import { RegistryCache } from '../registry/cache.js';
import { RegistryClient } from '../registry/client.js';
import {
  addMarketplace,
  loadMarketplaces,
  marketplaceNameFromUrl,
  removeMarketplace,
  type Marketplace,
} from '../registry/marketplaces.js';
import { DEFAULT_MARKETPLACE } from '../registry/dependency-spec.js';
import type { GitSource, RegistryIndex } from '../registry/types.js';

interface AddOptions {
  name?: string;
  yes?: boolean;
}

export async function addMarketplaceCommand(url: string, options: AddOptions = {}): Promise<void> {
  const marketplace: Marketplace = { name: options.name ?? marketplaceNameFromUrl(url), url };

  // Fetching first is what makes the confirmation worth anything: the user sees
  // the origin and what it actually serves, not just the URL they typed.
  process.stdout.write(`Fetching ${chalk.bold(marketplace.url)}... `);
  const index = await new RegistryClient(marketplace).fetchIndex();
  console.log(chalk.green(`✓ ${index.packages.length} packages`));

  console.log(`\n  name:     ${chalk.bold(marketplace.name)}`);
  console.log(`  origin:   ${marketplace.url}`);
  console.log(`  packages: ${index.packages.map(p => p.name).slice(0, 8).join(', ')}${index.packages.length > 8 ? ', …' : ''}`);
  console.log(chalk.yellow(
    `\n  Packages installed from a marketplace run on your machine with your credentials.`,
  ));

  if (!options.yes) {
    const { confirm } = await import('@inquirer/prompts');
    const proceed = await confirm({ message: `Register '${marketplace.name}'?`, default: false });
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }
  }

  await addMarketplace(marketplace);
  await new RegistryCache(undefined, marketplace.name).write(index);
  console.log(chalk.green(`✓ Registered '${marketplace.name}'`));
  console.log(chalk.gray(`  Install from it: studio registry install ${marketplace.name}:<package>`));
}

/**
 * Assert every externally-hosted entry of an index against its payload. Run by a
 * marketplace's CI, where it is the only gate: a `git` entry is merged as a URL,
 * so nothing else ever compares what it claims with what it serves.
 */
export async function validateMarketplaceCommand(indexPath = 'index.json'): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  const { materializeGit } = await import('../registry/git-source.js');
  const { verifyPayload } = await import('../registry/verify.js');
  const { RegistryClient } = await import('../registry/client.js');

  const index = JSON.parse(await readFile(indexPath, 'utf8')) as RegistryIndex;
  const hosted = index.packages.filter(p => p.source?.type === 'git');
  if (hosted.length === 0) {
    console.log(chalk.gray('No git-sourced entries to validate.'));
    return;
  }

  let failed = false;
  for (const entry of hosted) {
    const source = entry.source as GitSource;
    try {
      await materializeGit(source);
      const problems = verifyPayload(
        await new RegistryClient().fetchDirectoryFiles(source),
        entry,
      );
      if (problems.length === 0) {
        console.log(chalk.green(`  ✓ ${entry.name} @ ${source.sha.slice(0, 7)}`));
        continue;
      }
      failed = true;
      console.log(chalk.red(`  ✗ ${entry.name}`));
      for (const problem of problems) console.log(`      ${problem}`);
    } catch (err) {
      failed = true;
      console.log(chalk.red(`  ✗ ${entry.name} — ${err instanceof Error ? err.message : err}`));
    }
  }

  if (failed) process.exit(1);
}

export async function listMarketplacesCommand(): Promise<void> {
  const marketplaces = await loadMarketplaces();
  console.log();
  for (const marketplace of marketplaces) {
    const suffix = marketplace.name === DEFAULT_MARKETPLACE ? chalk.gray(' (default)') : '';
    console.log(`  ${chalk.bold(marketplace.name)}${suffix}`);
    console.log(`    ${chalk.gray(marketplace.url)}`);
  }
  console.log();
}

export async function removeMarketplaceCommand(name: string): Promise<void> {
  await removeMarketplace(name);
  console.log(chalk.green(`✓ Removed '${name}'`));
  console.log(chalk.gray('  Packages already installed from it are untouched.'));
}

export function createMarketplaceCommand(): Command {
  const marketplace = new Command('marketplace')
    .description('Manage the registries packages are installed from');

  marketplace
    .command('add <url>')
    .description('Register a marketplace repository')
    .option('--name <name>', 'Name to qualify its packages with (defaults to the repository name)')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .action(async (url: string, options: AddOptions) => {
      try {
        await addMarketplaceCommand(url, options);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  marketplace
    .command('list')
    .description('List registered marketplaces')
    .action(() => listMarketplacesCommand());

  marketplace
    .command('validate [index]')
    .description("Check a marketplace index's git-sourced entries against their payloads")
    .action(async (index?: string) => {
      try {
        await validateMarketplaceCommand(index);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  marketplace
    .command('remove <name>')
    .description('Unregister a marketplace')
    .action(async (name: string) => {
      try {
        await removeMarketplaceCommand(name);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  return marketplace;
}
