import type { PackageMetadata, PackageType, RegistryIndex, Lockfile, PackageDependencies } from './types.js';
import { parseDependencySpec, DEFAULT_MARKETPLACE, type DependencySpec } from './dependency-spec.js';
import { selectVersion, type Constraint } from './constraints.js';

export interface DependencyNode {
  name: string;
  type: PackageType;
  version: string;
  /** Every range declared on this node, so the caller can record its own. */
  constraints: Constraint[];
}

export interface ResolvedGraph {
  required: DependencyNode[];
  recommended: DependencyNode[];
}

type MetadataFetcher = (name: string) => Promise<PackageMetadata>;

/** Parsed dependency entries of one kind, tagged with the category they came from. */
function specsOf(
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

function assertRegisteredMarketplace(spec: DependencySpec, requiredBy: string): void {
  if (spec.marketplace === DEFAULT_MARKETPLACE) return;
  // Never resolve against a marketplace the user has not registered, and never
  // add one silently. `studio marketplace add` is the missing half (ADR 0001).
  throw new Error(
    `Dependency '${spec.raw}' of package '${requiredBy}' names marketplace ` +
    `'${spec.marketplace}', which is not registered.`
  );
}

export async function resolveDependencies(
  rootPackageName: string,
  meta: PackageMetadata,
  index: RegistryIndex,
  _lockfile: Lockfile,
  fetchMeta: MetadataFetcher,
): Promise<ResolvedGraph> {
  const constraints = new Map<string, Constraint[]>();
  const order: string[] = [];
  const visiting = new Set<string>();

  async function visit(name: string, pkgMeta: PackageMetadata): Promise<void> {
    if (!pkgMeta.dependencies) return;
    visiting.add(name);

    for (const { spec, category } of specsOf(pkgMeta.dependencies, 'required')) {
      assertRegisteredMarketplace(spec, name);
      if (visiting.has(spec.name)) {
        throw new Error(`Circular dependency detected: ${spec.name} is part of a cycle`);
      }
      if (!index.packages.some((p) => p.name === spec.name)) {
        // Fail loud, before install: a required dep absent from the index would
        // otherwise install "successfully" and then crash at run time.
        throw new Error(
          `Missing required dependency '${spec.name}' (${category}) of package '${name}': ` +
          `not found in the registry index. Run 'studio registry sync' or check the package name.`
        );
      }

      const known = constraints.get(spec.name);
      if (known) {
        known.push({ range: spec.range, requiredBy: name });
      } else {
        constraints.set(spec.name, [{ range: spec.range, requiredBy: name }]);
        order.push(spec.name);
        await visit(spec.name, await fetchMeta(spec.name));
      }
    }

    visiting.delete(name);
  }

  await visit(rootPackageName, meta);

  const required: DependencyNode[] = order.map((name) => {
    const candidates = index.packages.filter((p) => p.name === name);
    const nodeConstraints = constraints.get(name)!;
    return {
      name,
      type: candidates[0].type as PackageType,
      version: selectVersion(name, nodeConstraints, candidates),
      constraints: nodeConstraints,
    };
  });

  const recommended: DependencyNode[] = [];
  for (const { spec } of meta.dependencies ? specsOf(meta.dependencies, 'recommended') : []) {
    assertRegisteredMarketplace(spec, rootPackageName);
    const candidates = index.packages.filter((p) => p.name === spec.name);
    // A missing recommended dependency is optional — skipped, not fatal.
    if (candidates.length === 0) continue;
    const nodeConstraints = [{ range: spec.range, requiredBy: rootPackageName }];
    recommended.push({
      name: spec.name,
      type: candidates[0].type as PackageType,
      version: selectVersion(spec.name, nodeConstraints, candidates),
      constraints: nodeConstraints,
    });
  }

  return { required, recommended };
}
