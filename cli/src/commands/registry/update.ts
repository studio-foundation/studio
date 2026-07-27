import chalk from 'chalk';
import { RegistryLockfile } from '../../registry/lockfile.js';
import { RegistryCache } from '../../registry/cache.js';
import { syncRegistry } from './sync.js';
import { installPackage } from './install.js';
import { findStudioDir } from '../../studio-dir.js';
import { constraintsOf, formatConstraints, selectVersion, unsatisfied, type Constraint } from '../../registry/constraints.js';
import type { LockfileEntry, PackageEntry } from '../../registry/types.js';
import { resolve } from 'node:path';

export interface OutdatedEntry {
  name: string;
  installed: string;
  /** Highest version the recorded constraints accept. */
  wanted: string;
  /** Highest version published, constraints ignored. */
  latest: string;
  type: string;
  /** The constraints keeping `wanted` below `latest`, when the two differ. */
  heldBy?: string;
}

interface UpdateOptions {
  studioDir?: string;
  cwd?: string;
}

async function loadIndexAndLockfile(options: UpdateOptions) {
  const studioDir = options.studioDir ??
    (await findStudioDir(options.cwd ?? process.cwd()) ?? resolve(process.cwd(), '.studio'));
  await syncRegistry({ force: false, silent: true });
  const index = await new RegistryCache().read();
  return { studioDir, index, lockfile: new RegistryLockfile(studioDir) };
}

/** The outdated row for one installed package, or null when it has nowhere to move. */
export function outdatedEntry(
  entry: { name: string } & LockfileEntry,
  candidates: PackageEntry[],
): OutdatedEntry | null {
  if (candidates.length === 0) return null;

  const constraints = constraintsOf(entry);
  const latest = selectVersion(entry.name, [], candidates);
  // An unsatisfiable set is a conflict to report, not a crash: the package has
  // nothing it can move to, which is exactly what a zero-move row says.
  let wanted: string;
  try {
    wanted = selectVersion(entry.name, constraints, candidates);
  } catch {
    wanted = entry.version;
  }

  if (wanted === entry.version && latest === entry.version) return null;

  return {
    name: entry.name,
    installed: entry.version,
    wanted,
    latest,
    type: entry.type,
    heldBy: wanted === latest ? undefined : formatConstraints(constraints),
  };
}

export async function outdatedPackages(options: UpdateOptions = {}): Promise<OutdatedEntry[]> {
  const { index, lockfile } = await loadIndexAndLockfile(options);
  if (!index) return [];

  return (await lockfile.list())
    .map(entry => outdatedEntry(entry, index.packages.filter(p => p.name === entry.name)))
    .filter((row): row is OutdatedEntry => row !== null);
}

export async function outdatedCommand(options: UpdateOptions = {}): Promise<void> {
  const outdated = await outdatedPackages(options);
  if (outdated.length === 0) {
    console.log(chalk.green('All packages are up to date.'));
    return;
  }
  console.log(chalk.bold('\nOutdated packages:\n'));
  for (const pkg of outdated) {
    const move = pkg.wanted === pkg.installed
      ? chalk.gray(`${pkg.installed} (no update within constraints)`)
      : `${chalk.red(pkg.installed)} → ${chalk.green(pkg.wanted)}`;
    console.log(`  ${chalk.bold(pkg.name)} ${move} [${pkg.type}]`);
    if (pkg.heldBy) {
      console.log(chalk.yellow(`    latest is ${pkg.latest}, held back by ${pkg.heldBy}`));
    }
  }
  console.log(`\nRun: studio registry update <name>`);
}

function targetVersion(
  name: string,
  candidates: PackageEntry[],
  constraints: Constraint[],
  latest: boolean,
): string {
  if (!latest) return selectVersion(name, constraints, candidates);

  const target = selectVersion(name, [], candidates);
  const broken = unsatisfied(target, constraints);
  if (broken.length > 0) {
    console.log(chalk.yellow(
      `⚠ v${target} does not satisfy ${formatConstraints(broken)} — those packages may break.`
    ));
  }
  return target;
}

export async function updateCommand(
  name: string,
  options: { latest?: boolean } & UpdateOptions = {},
): Promise<void> {
  try {
    const { studioDir, index, lockfile } = await loadIndexAndLockfile(options);
    const entry = await lockfile.get(name);
    if (!entry) throw new Error(`'${name}' is not installed`);

    const candidates = index?.packages.filter(p => p.name === name) ?? [];
    if (candidates.length === 0) throw new Error(`Package '${name}' not found in registry`);

    const constraints = constraintsOf(entry);
    const target = targetVersion(name, candidates, constraints, options.latest ?? false);

    if (target === entry.version) {
      const qualifier = constraints.length > 0 && !options.latest ? ' — the highest its dependents accept' : '';
      console.log(chalk.green(`${name} is already at v${target}${qualifier}.`));
      return;
    }

    await installPackage(`${name}@${target}`, { force: true, studioDir });
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}
