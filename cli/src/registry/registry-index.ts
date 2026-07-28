import { RegistryCache } from './cache.js';
import { loadMarketplaces, type Marketplace } from './marketplaces.js';
import { DEFAULT_MARKETPLACE } from './dependency-spec.js';
import { seedIndex } from './seed.js';
import type { PackageEntry } from './types.js';

/** An index entry knows which marketplace served it — names are unique per marketplace, not globally. */
export interface IndexedPackage extends PackageEntry {
  marketplace: string;
}

export interface MergedIndex {
  packages: IndexedPackage[];
  marketplaces: Marketplace[];
}

interface LoadOptions {
  cacheDir?: string;
  marketplacesFile?: string;
  /** Stand in for an uncached default marketplace with the bundled snapshot. */
  seed?: boolean;
}

/** Every registered marketplace's cached index, merged. Assumes `syncRegistry` ran. */
export async function loadMergedIndex(options: LoadOptions = {}): Promise<MergedIndex> {
  const marketplaces = await loadMarketplaces(options.marketplacesFile);
  const packages: IndexedPackage[] = [];
  for (const marketplace of marketplaces) {
    // The snapshot only ever stands in for the marketplace it was bundled from,
    // and only where an empty listing would be a failure rather than a fact.
    const seeded = options.seed && marketplace.name === DEFAULT_MARKETPLACE ? seedIndex() : null;
    const index = await new RegistryCache(options.cacheDir, marketplace.name).read() ?? seeded;
    if (!index) continue;
    packages.push(...index.packages.map((p) => ({ ...p, marketplace: marketplace.name })));
  }
  return { packages, marketplaces };
}

/**
 * Every index entry for one package name, newest-first ordering left as published.
 *
 * An unqualified name that exists in more than one marketplace is an error, never
 * a pick: which one wins would otherwise depend on registration order.
 */
export function candidatesFor(
  packages: IndexedPackage[],
  name: string,
  marketplace?: string,
): IndexedPackage[] {
  const byName = packages.filter((p) => p.name === name);
  if (marketplace) return byName.filter((p) => p.marketplace === marketplace);

  const owners = [...new Set(byName.map((p) => p.marketplace))];
  if (owners.length > 1) {
    throw new Error(
      `Package '${name}' exists in several marketplaces (${owners.join(', ')}). ` +
      `Qualify it: ${owners.map((m) => `${m}:${name}`).join(' or ')}.`,
    );
  }
  return byName;
}

export interface PackageRef {
  marketplace?: string;
  name: string;
  version?: string;
}

/** A package as typed on the command line: `[marketplace:]name[@version]`. */
export function parsePackageRef(raw: string): PackageRef {
  const trimmed = raw.trim();
  const colon = trimmed.indexOf(':');
  const marketplace = colon === -1 ? undefined : trimmed.slice(0, colon).trim();
  const rest = colon === -1 ? trimmed : trimmed.slice(colon + 1).trim();
  const [name, version] = rest.split('@');

  if (!name) throw new Error(`Invalid package name: '${raw}'`);
  if (colon !== -1 && !marketplace) throw new Error(`Invalid package name: '${raw}' — empty marketplace`);
  return { marketplace, name, version: version || undefined };
}

/** The index entry to install for `name[@version]`, or null when there is none. */
export function entryFor(
  packages: IndexedPackage[],
  name: string,
  version?: string,
  marketplace?: string,
): IndexedPackage | null {
  const candidates = candidatesFor(packages, name, marketplace);
  if (candidates.length === 0) return null;
  return (version && candidates.find((c) => c.version === version)) || candidates[0];
}
