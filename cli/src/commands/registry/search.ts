import chalk from 'chalk';
import { RegistryCache } from '../../registry/cache.js';
import { syncRegistry } from './sync.js';
import type { PackageEntry, PackageType } from '../../registry/types.js';

export function searchPackages(
  packages: PackageEntry[],
  query?: string,
  type?: PackageType | string,
): PackageEntry[] {
  let results = packages;

  if (type) {
    results = results.filter(p => p.type === type);
  }

  if (query) {
    const q = query.toLowerCase();
    results = results.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.tags.some(t => t.toLowerCase().includes(q)),
    );
  }

  return results;
}

function renderPackage(pkg: PackageEntry): void {
  console.log(
    `  ${chalk.bold(pkg.name)} ${chalk.gray(`v${pkg.version}`)} ${chalk.cyan(`[${pkg.type}]`)}`,
  );
  console.log(`    ${pkg.description}`);
  if (pkg.tags.length > 0) {
    console.log(`    ${chalk.gray(pkg.tags.join(', '))}`);
  }
}

interface SearchOptions {
  type?: string;
}

export async function searchCommand(query: string, options: SearchOptions = {}): Promise<void> {
  await syncRegistry({ force: false, silent: true });
  const cache = new RegistryCache();
  const index = await cache.read();
  if (!index) {
    console.error(chalk.red('Failed to load registry. Run: studio registry sync'));
    process.exit(1);
  }

  const results = searchPackages(index.packages, query, options.type as PackageType | undefined);

  if (results.length === 0) {
    console.log(chalk.yellow(`No packages found for "${query}"`));
    return;
  }

  console.log(chalk.bold(`\n${results.length} package${results.length > 1 ? 's' : ''} found:\n`));
  for (const pkg of results) {
    renderPackage(pkg);
    console.log();
  }
  console.log(chalk.gray(`Install: studio registry install <name>`));
}

export async function browseCommand(): Promise<void> {
  await syncRegistry({ force: false, silent: true });
  const cache = new RegistryCache();
  const index = await cache.read();
  if (!index) {
    console.error(chalk.red('Failed to load registry. Run: studio registry sync'));
    process.exit(1);
  }

  const sorted = [...index.packages].sort((a, b) => b.downloads - a.downloads);

  console.log(chalk.bold(`\nStudio Community Registry — ${sorted.length} packages\n`));

  const byType: Record<string, PackageEntry[]> = {};
  for (const pkg of sorted) {
    if (!byType[pkg.type]) byType[pkg.type] = [];
    byType[pkg.type].push(pkg);
  }

  for (const [type, pkgs] of Object.entries(byType)) {
    console.log(chalk.bold.underline(`${type}s`));
    for (const pkg of pkgs) {
      renderPackage(pkg);
      console.log();
    }
  }
}
