import chalk from 'chalk';
import { syncRegistry } from './sync.js';
import { loadMergedIndex, type IndexedPackage } from '../../registry/registry-index.js';
import { DEFAULT_MARKETPLACE } from '../../registry/dependency-spec.js';
import type { PackageEntry, PackageType } from '../../registry/types.js';

export function searchPackages<T extends PackageEntry>(
  packages: T[],
  query?: string,
  type?: PackageType | string,
): T[] {
  let results = packages;

  if (type) {
    // Matches the packaging type (`plugin`, `template`) or a provided content
    // kind (`tool`, `agent`…), so `--type tool` keeps meaning what it did.
    const kind = type.endsWith('s') ? type : `${type}s`;
    results = results.filter(p => p.type === type || (p.provides?.[kind as keyof typeof p.provides]?.length ?? 0) > 0);
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

/** What a package delivers, for display: a template is one thing, a plugin is its `provides`. */
function providedKinds(pkg: PackageEntry): string[] {
  if (pkg.type === 'template') return ['templates'];
  const kinds = Object.entries(pkg.provides ?? {})
    .filter(([, names]) => names && names.length > 0)
    .map(([kind]) => kind);
  return kinds.length > 0 ? kinds : ['plugins'];
}

function renderPackage(pkg: IndexedPackage): void {
  // The marketplace is shown only when it is not the default: with one registered
  // marketplace — the common case — it would be noise on every row.
  const origin = pkg.marketplace === DEFAULT_MARKETPLACE ? '' : ` ${chalk.magenta(pkg.marketplace)}`;
  console.log(
    `  ${chalk.bold(pkg.name)} ${chalk.gray(`v${pkg.version}`)} ${chalk.cyan(`[${pkg.type}]`)}${origin}`,
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
  const { packages } = await loadMergedIndex();
  if (packages.length === 0) {
    console.error(chalk.red('Failed to load registry. Run: studio registry sync'));
    process.exit(1);
  }

  const results = searchPackages(packages, query, options.type as PackageType | undefined);

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
  const { packages } = await loadMergedIndex();
  if (packages.length === 0) {
    console.error(chalk.red('Failed to load registry. Run: studio registry sync'));
    process.exit(1);
  }

  const sorted = [...packages].sort((a, b) => b.downloads - a.downloads);

  console.log(chalk.bold(`\nStudio Community Registry — ${sorted.length} packages\n`));

  // Grouped by what a package delivers, not by its packaging type — with two
  // packaging types, "plugins" and "templates" would be the whole listing.
  const byKind: Record<string, IndexedPackage[]> = {};
  for (const pkg of sorted) {
    for (const kind of providedKinds(pkg)) {
      (byKind[kind] ??= []).push(pkg);
    }
  }

  for (const [kind, pkgs] of Object.entries(byKind).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(chalk.bold.underline(kind));
    for (const pkg of pkgs) {
      renderPackage(pkg);
      console.log();
    }
  }
}
