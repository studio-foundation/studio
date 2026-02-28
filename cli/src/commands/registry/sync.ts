import chalk from 'chalk';
import { RegistryCache } from '../../registry/cache.js';
import { RegistryClient } from '../../registry/client.js';

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
  const index = await client.fetchIndex();
  await cache.write(index);
  if (!options.silent) console.log(chalk.green(`✓ ${index.packages.length} packages`));
}
