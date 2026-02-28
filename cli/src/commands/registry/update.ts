import chalk from 'chalk';
import { RegistryLockfile } from '../../registry/lockfile.js';
import { RegistryCache } from '../../registry/cache.js';
import { syncRegistry } from './sync.js';
import { installPackage } from './install.js';
import { findStudioDir } from '../../studio-dir.js';
import { resolve } from 'node:path';

interface OutdatedEntry {
  name: string;
  installed: string;
  latest: string;
  type: string;
}

interface UpdateOptions {
  studioDir?: string;
  cwd?: string;
}

export async function outdatedPackages(options: UpdateOptions = {}): Promise<OutdatedEntry[]> {
  const studioDir = options.studioDir ??
    (findStudioDir(options.cwd ?? process.cwd()) ?? resolve(process.cwd(), '.studio'));
  await syncRegistry({ force: false, silent: true });
  const cache = new RegistryCache();
  const index = await cache.read();
  if (!index) return [];

  const lockfile = new RegistryLockfile(studioDir);
  const installed = await lockfile.list();
  const results: OutdatedEntry[] = [];

  for (const entry of installed) {
    const latest = index.packages.find(p => p.name === entry.name);
    if (latest && latest.version !== entry.version) {
      results.push({ name: entry.name, installed: entry.version, latest: latest.version, type: entry.type });
    }
  }

  return results;
}

export async function outdatedCommand(options: UpdateOptions = {}): Promise<void> {
  const outdated = await outdatedPackages(options);
  if (outdated.length === 0) {
    console.log(chalk.green('All packages are up to date.'));
    return;
  }
  console.log(chalk.bold('\nOutdated packages:\n'));
  for (const pkg of outdated) {
    console.log(`  ${chalk.bold(pkg.name)} ${chalk.red(pkg.installed)} → ${chalk.green(pkg.latest)} [${pkg.type}]`);
  }
  console.log(`\nRun: studio registry update <name>`);
}

export async function updateCommand(name: string): Promise<void> {
  try {
    await installPackage(name, { force: true });
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}
