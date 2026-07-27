import chalk from 'chalk';
import { RegistryCache } from '../../registry/cache.js';
import { RegistryClient } from '../../registry/client.js';
import { loadMarketplaces, type Marketplace } from '../../registry/marketplaces.js';
import { DEFAULT_MARKETPLACE } from '../../registry/dependency-spec.js';

interface SyncOptions {
  cacheDir?: string;
  marketplacesFile?: string;
  force?: boolean;
  silent?: boolean;
}

async function syncOne(marketplace: Marketplace, options: SyncOptions): Promise<number | null> {
  const cache = new RegistryCache(options.cacheDir, marketplace.name);
  if (!options.force && await cache.isFresh()) return null;

  const index = await new RegistryClient(marketplace).fetchIndex();
  await cache.write(index);
  return index.packages.length;
}

export async function syncRegistry(options: SyncOptions = {}): Promise<void> {
  const marketplaces = await loadMarketplaces(options.marketplacesFile);
  let synced = false;

  for (const marketplace of marketplaces) {
    try {
      const count = await syncOne(marketplace, options);
      if (count === null) continue;
      synced = true;
      if (!options.silent) console.log(chalk.green(`✓ ${marketplace.name}: ${count} packages`));
    } catch (err) {
      const message = `Failed to sync marketplace '${marketplace.name}': ${err instanceof Error ? err.message : err}`;
      // One unreachable private marketplace must not block installs from the
      // others; the default marketplace failing is an outage and stays fatal.
      if (marketplace.name === DEFAULT_MARKETPLACE) throw new Error(message, { cause: err });
      console.error(chalk.yellow(`⚠ ${message}`));
    }
  }

  if (!synced && !options.silent) console.log(chalk.gray('Registry index is up to date.'));
}
