import chalk from 'chalk';
import { RegistryCache } from '../../registry/cache.js';
import { RegistryClient } from '../../registry/client.js';
import { loadMarketplaces, type Marketplace } from '../../registry/marketplaces.js';
import { DEFAULT_MARKETPLACE } from '../../registry/dependency-spec.js';
import { seedIndex } from '../../registry/seed.js';

interface SyncOptions {
  cacheDir?: string;
  marketplacesFile?: string;
  force?: boolean;
  silent?: boolean;
}

type SyncOutcome = { packages: number } | 'seeded' | 'fresh';

async function syncOne(marketplace: Marketplace, options: SyncOptions): Promise<SyncOutcome> {
  const cache = new RegistryCache(options.cacheDir, marketplace.name);
  if (!options.force && await cache.isFresh()) return 'fresh';

  let index;
  try {
    index = await new RegistryClient(marketplace).fetchIndex();
  } catch (err) {
    // The seeded index is deliberately not cached: caching it would make the next
    // online run skip its sync for a day and keep serving the stale snapshot. It
    // only ever stands in for the marketplace it was bundled from.
    if (marketplace.name !== DEFAULT_MARKETPLACE || !seedIndex()) throw err;
    return 'seeded';
  }

  await cache.write(index);
  return { packages: index.packages.length };
}

export async function syncRegistry(options: SyncOptions = {}): Promise<void> {
  const marketplaces = await loadMarketplaces(options.marketplacesFile);
  let reported = false;

  for (const marketplace of marketplaces) {
    try {
      const outcome = await syncOne(marketplace, options);
      if (outcome === 'fresh') continue;
      reported = true;
      if (options.silent) continue;
      console.log(outcome === 'seeded'
        ? chalk.yellow(`${marketplace.name}: offline — using the bundled seed index`)
        : chalk.green(`✓ ${marketplace.name}: ${outcome.packages} packages`));
    } catch (err) {
      const message = `Failed to sync marketplace '${marketplace.name}': ${err instanceof Error ? err.message : err}`;
      // One unreachable private marketplace must not block installs from the
      // others; the default marketplace failing is an outage and stays fatal.
      if (marketplace.name === DEFAULT_MARKETPLACE) throw new Error(message, { cause: err });
      console.error(chalk.yellow(`⚠ ${message}`));
    }
  }

  if (!reported && !options.silent) console.log(chalk.gray('Registry index is up to date.'));
}
