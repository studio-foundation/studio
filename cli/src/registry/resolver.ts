import type { PackageMetadata, PackageType, Lockfile, PackageDependencies } from './types.js';
import { parseDependencySpec, type DependencySpec } from './dependency-spec.js';
import { selectVersion, type Constraint } from './constraints.js';
import { candidatesFor, type IndexedPackage } from './registry-index.js';

export interface DependencyNode {
  name: string;
  marketplace: string;
  type: PackageType;
  version: string;
  /** Every range declared on this node, so the caller can record its own. */
  constraints: Constraint[];
}

export interface ResolvedGraph {
  required: DependencyNode[];
  recommended: DependencyNode[];
}

type MetadataFetcher = (name: string, marketplace: string) => Promise<PackageMetadata>;

export interface ResolveOptions {
  /** Marketplace of the package being resolved — where its unqualified deps resolve. */
  marketplace: string;
  /** Names of every registered marketplace. A dependency may name no other. */
  registered: string[];
}

/** Parsed dependency entries of one kind, tagged with the category they came from. */
export function specsOf(
  deps: PackageDependencies,
  kind: 'required' | 'recommended',
): Array<{ spec: DependencySpec; category: string }> {
  const out: Array<{ spec: DependencySpec; category: string }> = [];
  for (const [category, entry] of Object.entries(deps)) {
    const names: string[] = (entry as Record<string, string[]>)[kind] ?? [];
    for (const raw of names) {
      out.push({ spec: parseDependencySpec(raw), category });
    }
  }
  return out;
}

/**
 * Which marketplace a dependency resolves against: the one it names, or the
 * dependent's own. A marketplace the user has not registered is refused rather
 * than added silently — `studio marketplace add` is a deliberate act (ADR 0001).
 */
function marketplaceOf(spec: DependencySpec, requiredBy: string, options: ResolveOptions): string {
  if (!spec.marketplace) return options.marketplace;
  if (!options.registered.includes(spec.marketplace)) {
    throw new Error(
      `Dependency '${spec.raw}' of package '${requiredBy}' names marketplace ` +
      `'${spec.marketplace}', which is not registered. Run: studio marketplace add <url> ` +
      `--name ${spec.marketplace}`,
    );
  }
  return spec.marketplace;
}

export async function resolveDependencies(
  rootPackageName: string,
  meta: PackageMetadata,
  packages: IndexedPackage[],
  _lockfile: Lockfile,
  fetchMeta: MetadataFetcher,
  options: ResolveOptions,
): Promise<ResolvedGraph> {
  const constraints = new Map<string, Constraint[]>();
  const targets = new Map<string, { name: string; marketplace: string }>();
  const order: string[] = [];
  const visiting = new Set<string>();

  async function visit(name: string, marketplace: string, pkgMeta: PackageMetadata): Promise<void> {
    if (!pkgMeta.dependencies) return;
    const selfKey = `${marketplace}:${name}`;
    visiting.add(selfKey);

    for (const { spec, category } of specsOf(pkgMeta.dependencies, 'required')) {
      const depMarketplace = marketplaceOf(spec, name, { ...options, marketplace });
      const key = `${depMarketplace}:${spec.name}`;
      if (visiting.has(key)) {
        throw new Error(`Circular dependency detected: ${spec.name} is part of a cycle`);
      }
      if (candidatesFor(packages, spec.name, depMarketplace).length === 0) {
        // Fail loud, before install: a required dep absent from the index would
        // otherwise install "successfully" and then crash at run time.
        throw new Error(
          `Missing required dependency '${spec.name}' (${category}) of package '${name}': ` +
          `not found in marketplace '${depMarketplace}'. Run 'studio registry sync' or check the package name.`
        );
      }

      const known = constraints.get(key);
      if (known) {
        known.push({ range: spec.range, requiredBy: name });
      } else {
        constraints.set(key, [{ range: spec.range, requiredBy: name }]);
        targets.set(key, { name: spec.name, marketplace: depMarketplace });
        order.push(key);
        await visit(spec.name, depMarketplace, await fetchMeta(spec.name, depMarketplace));
      }
    }

    visiting.delete(selfKey);
  }

  await visit(rootPackageName, options.marketplace, meta);

  const required: DependencyNode[] = order.map((key) => {
    const { name, marketplace } = targets.get(key)!;
    const candidates = candidatesFor(packages, name, marketplace);
    const nodeConstraints = constraints.get(key)!;
    return {
      name,
      marketplace,
      type: candidates[0].type as PackageType,
      version: selectVersion(name, nodeConstraints, candidates),
      constraints: nodeConstraints,
    };
  });

  const recommended: DependencyNode[] = [];
  for (const { spec } of meta.dependencies ? specsOf(meta.dependencies, 'recommended') : []) {
    const depMarketplace = marketplaceOf(spec, rootPackageName, options);
    const candidates = candidatesFor(packages, spec.name, depMarketplace);
    // A missing recommended dependency is optional — skipped, not fatal.
    if (candidates.length === 0) continue;
    const nodeConstraints = [{ range: spec.range, requiredBy: rootPackageName }];
    recommended.push({
      name: spec.name,
      marketplace: depMarketplace,
      type: candidates[0].type as PackageType,
      version: selectVersion(spec.name, nodeConstraints, candidates),
      constraints: nodeConstraints,
    });
  }

  return { required, recommended };
}
