import chalk from 'chalk';
import { RegistryCache } from '../../registry/cache.js';
import { RegistryClient } from '../../registry/client.js';
import { seedIndex } from '../../registry/seed.js';

interface SyncOptions {
  cacheDir?: string;
  force?: boolean;
  silent?: boolean;
}

export async function syncRegistry(options: SyncOptions = {}): Promise<void> {
  const cache = new RegistryCache(options.cacheDir);

  if (!options.force && await cache.isFresh()) {
    if (!options.silent) console.log(chalk.gray('Registry index is up to date.'));
    return;
  }

  if (!options.silent) process.stdout.write('Syncing registry... ');
  const client = new RegistryClient();

  let index;
  try {
    index = await client.fetchIndex();
  } catch (err) {
    // The seeded index is deliberately not cached: caching it would make the next
    // online run skip its sync for a day and keep serving the stale snapshot.
    if (!seedIndex()) throw err;
    if (!options.silent) console.log(chalk.yellow('offline — using the bundled seed index'));
    return;
  }

  await cache.write(index);
  if (!options.silent) console.log(chalk.green(`✓ ${index.packages.length} packages`));
}
