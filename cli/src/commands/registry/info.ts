import chalk from 'chalk';
import { resolve } from 'node:path';
import { syncRegistry } from './sync.js';
import { RegistryLockfile } from '../../registry/lockfile.js';
import { findStudioDir } from '../../studio-dir.js';
import { candidatesFor, loadMergedIndex, parsePackageRef, type IndexedPackage } from '../../registry/registry-index.js';
import { specsOf } from '../../registry/resolver.js';
import { DEFAULT_MARKETPLACE } from '../../registry/dependency-spec.js';
import { checkStudioVersion } from '../../version-guard.js';
import type { LockfileEntry } from '../../registry/types.js';

export interface PackageInfo {
  entry: IndexedPackage;
  /** Every version the index carries for this name, in published order. */
  versions: string[];
  /** The lockfile entry for this name, or null when the project has none. */
  installed: ({ name: string } & LockfileEntry) | null;
  /** Set when the running CLI does not satisfy the declared `studio_version`. */
  incompatible: string | null;
  /** Dependency entries as published, flattened across categories — resolution is by name. */
  dependencies: { required: string[]; recommended: string[] };
}

/**
 * The entry `info` describes, plus what the project already knows about it.
 *
 * An ambiguous unqualified name throws out of `candidatesFor`, as it does for
 * `install`: which marketplace wins would otherwise depend on registration order.
 * A requested version that was never published is an error rather than a silent
 * fallback to the newest — the whole point of the command is to inspect *that* one.
 */
export function resolvePackageInfo(
  packages: IndexedPackage[],
  ref: string,
  lockEntry: LockfileEntry | null,
): PackageInfo {
  const { marketplace, name, version } = parsePackageRef(ref);
  const candidates = candidatesFor(packages, name, marketplace);
  if (candidates.length === 0) {
    const where = marketplace ? ` in marketplace '${marketplace}'` : '';
    throw new Error(`Package '${name}' not found in registry${where}`);
  }

  const versions = candidates.map((c) => c.version);
  const entry = version ? candidates.find((c) => c.version === version) : candidates[0];
  if (!entry) {
    throw new Error(`Package '${name}' has no version ${version} in the registry (published: ${versions.join(', ')})`);
  }

  const deps = entry.dependencies ?? {};
  return {
    entry,
    versions,
    installed: lockEntry ? { name, ...lockEntry } : null,
    incompatible: checkStudioVersion(entry.studio_version, `Package '${name}'`),
    dependencies: {
      required: specsOf(deps, 'required').map(({ spec }) => spec.raw),
      recommended: specsOf(deps, 'recommended').map(({ spec }) => spec.raw),
    },
  };
}

const LABEL_WIDTH = 14;

function field(label: string, value: string): void {
  console.log(`  ${chalk.gray(label.padEnd(LABEL_WIDTH))}${value}`);
}

/** Where the payload comes from — a directory in the marketplace repo, or someone else's repo. */
function sourceOf(entry: IndexedPackage): string {
  if (entry.source.type === 'local') return entry.source.path;
  const path = entry.source.path ? ` (${entry.source.path})` : '';
  return `${entry.source.url}${path} @ ${entry.source.ref} ${chalk.gray(entry.source.sha.slice(0, 8))}`;
}

function renderInfo(info: PackageInfo): void {
  const { entry } = info;

  console.log();
  console.log(
    `${chalk.bold(entry.name)} ${chalk.gray(`v${entry.version}`)} ` +
    `${chalk.cyan(`[${entry.type}]`)} ${chalk.magenta(entry.marketplace)}`,
  );
  console.log(`  ${entry.description}\n`);

  field('Author', entry.author);
  field('License', entry.license);
  if (entry.tags.length > 0) field('Tags', entry.tags.join(', '));
  field('Studio', entry.studio_version ?? chalk.gray('any'));
  field('Versions', info.versions.join(', '));
  field('Source', sourceOf(entry));

  const provides = Object.entries(entry.provides ?? {}).filter(([, names]) => names && names.length > 0);
  if (provides.length > 0) {
    console.log(`\n  ${chalk.bold('Provides')}`);
    for (const [kind, names] of provides) {
      console.log(`    ${chalk.gray(kind.padEnd(LABEL_WIDTH - 2))}${names!.join(', ')}`);
    }
  }

  const { required, recommended } = info.dependencies;
  if (required.length > 0 || recommended.length > 0) {
    console.log(`\n  ${chalk.bold('Dependencies')}`);
    if (required.length > 0) console.log(`    ${chalk.gray('required'.padEnd(LABEL_WIDTH - 2))}${required.join(', ')}`);
    if (recommended.length > 0) console.log(`    ${chalk.gray('recommended'.padEnd(LABEL_WIDTH - 2))}${recommended.join(', ')}`);
  }

  console.log();
  if (info.installed) {
    // The lockfile is keyed by name alone, so an entry installed from another
    // marketplace is worth naming — it is not the package described above.
    const from = info.installed.marketplace && info.installed.marketplace !== entry.marketplace
      ? chalk.yellow(` (from ${info.installed.marketplace})`)
      : '';
    const drift = info.installed.version === entry.version ? '' : chalk.gray(` — registry has v${entry.version}`);
    field('Installed', `${chalk.green(`v${info.installed.version}`)}${from}${drift}`);
  } else {
    field('Installed', chalk.gray('no'));
  }

  if (info.incompatible) {
    console.log(`\n${chalk.yellow(`⚠ ${info.incompatible}`)}`);
  }

  if (!info.installed) {
    const qualified = entry.marketplace === DEFAULT_MARKETPLACE ? entry.name : `${entry.marketplace}:${entry.name}`;
    console.log(chalk.gray(`\nInstall: studio registry install ${qualified}`));
  }
}

interface InfoOptions {
  studioDir?: string;
  cwd?: string;
}

export async function infoCommand(ref: string, options: InfoOptions = {}): Promise<void> {
  try {
    const studioDir = options.studioDir ??
      (await findStudioDir(options.cwd ?? process.cwd()) ?? resolve(process.cwd(), '.studio'));

    await syncRegistry({ force: false, silent: true });
    // `seed: true` — inspecting a package with nothing cached is offline, not empty.
    const { packages } = await loadMergedIndex({ seed: true });
    const { name } = parsePackageRef(ref);

    renderInfo(resolvePackageInfo(packages, ref, await new RegistryLockfile(studioDir).get(name)));
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}
