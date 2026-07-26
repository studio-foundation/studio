import { readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import chalk from 'chalk';
import { mapCacheSegment } from '@studio-foundation/engine';
import { findStudioDir } from '../studio-dir.js';

export const MAP_CACHE_RELATIVE = join('runs', 'map-cache');

export interface CacheCleanOptions {
  pipeline?: string;
  dryRun?: boolean;
}

/** Count cached items per `<pipeline>/<stage>/<sub-pipeline>` namespace under `dir`. */
async function countByNamespace(dir: string, root: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  const walk = async (current: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.json')) {
        const ns = relative(root, current) || '.';
        counts.set(ns, (counts.get(ns) ?? 0) + 1);
      }
    }
  };

  await walk(dir);
  return counts;
}

export async function cacheCleanCommand(options: CacheCleanOptions): Promise<void> {
  const studioDir = await findStudioDir(process.cwd());
  if (!studioDir) {
    console.error(chalk.red('No .studio/ directory found. Run this from a Studio project.'));
    process.exit(1);
  }

  const root = join(studioDir, MAP_CACHE_RELATIVE);
  const target = options.pipeline ? join(root, mapCacheSegment(options.pipeline)) : root;

  const counts = await countByNamespace(target, root);
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

  if (total === 0) {
    console.log(chalk.gray(`Map cache already empty: ${target}`));
    return;
  }

  for (const [ns, n] of [...counts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    console.log(chalk.gray(`  ${ns}  ${n} item(s)`));
  }

  if (options.dryRun) {
    console.log(chalk.yellow(`Would clear ${total} cached map item(s) from ${target}`));
    return;
  }

  await rm(target, { recursive: true, force: true });
  console.log(chalk.green(`✓ Cleared ${total} cached map item(s) from ${target}`));
}
