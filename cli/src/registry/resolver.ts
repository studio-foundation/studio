import type { PackageMetadata, PackageType, RegistryIndex, Lockfile, PackageDependencies } from './types.js';

export interface DependencyNode {
  name: string;
  type: PackageType;
}

export interface ResolvedGraph {
  required: DependencyNode[];
  recommended: DependencyNode[];
}

type MetadataFetcher = (name: string) => Promise<PackageMetadata>;

/** Extract all dependency names (regardless of whether they're in the index) for cycle detection. */
function depNames(deps: PackageDependencies, kind: 'required' | 'recommended'): string[] {
  const names: string[] = [];
  for (const [, spec] of Object.entries(deps)) {
    const arr: string[] = (spec as Record<string, string[]>)[kind] ?? [];
    names.push(...arr);
  }
  return names;
}

function flattenDeps(
  deps: PackageDependencies,
  kind: 'required' | 'recommended',
  index: RegistryIndex,
  requiredBy: string,
): DependencyNode[] {
  const nodes: DependencyNode[] = [];
  for (const [category, spec] of Object.entries(deps)) {
    const names: string[] = (spec as Record<string, string[]>)[kind] ?? [];
    for (const name of names) {
      const entry = index.packages.find(p => p.name === name);
      if (entry) {
        nodes.push({ name, type: entry.type as PackageType });
      } else if (kind === 'required') {
        // Fail loud, before install: a required dep absent from the index would
        // otherwise install "successfully" and then crash at run time.
        throw new Error(
          `Missing required dependency '${name}' (${category}) of package '${requiredBy}': ` +
          `not found in the registry index. Run 'studio registry sync' or check the package name.`
        );
      }
      // A missing recommended dependency is optional — skipped, not fatal.
    }
  }
  return nodes;
}

export async function resolveDependencies(
  rootPackageName: string,
  meta: PackageMetadata,
  index: RegistryIndex,
  _lockfile: Lockfile,
  fetchMeta: MetadataFetcher,
): Promise<ResolvedGraph> {
  const resolved = new Map<string, DependencyNode>();
  const visiting = new Set<string>();

  // Track the root package so cycles back to it are detected
  visiting.add(rootPackageName);

  async function visit(name: string, pkgMeta: PackageMetadata): Promise<void> {
    if (visiting.has(name)) {
      throw new Error(`Circular dependency detected: ${name} is part of a cycle`);
    }
    if (resolved.has(name)) return;

    visiting.add(name);

    if (pkgMeta.dependencies) {
      // Check for cycles on all required names (even those not in index)
      for (const depName of depNames(pkgMeta.dependencies, 'required')) {
        if (visiting.has(depName)) {
          throw new Error(`Circular dependency detected: ${depName} is part of a cycle`);
        }
      }

      const requiredNodes = flattenDeps(pkgMeta.dependencies, 'required', index, name);
      for (const node of requiredNodes) {
        if (!resolved.has(node.name)) {
          const subMeta = await fetchMeta(node.name);
          await visit(node.name, subMeta);
          if (!resolved.has(node.name)) {
            resolved.set(node.name, node);
          }
        }
      }
    }

    visiting.delete(name);
  }

  if (meta.dependencies) {
    // Check for cycles at the first level too (root → dep that cycles back to root)
    for (const depName of depNames(meta.dependencies, 'required')) {
      if (visiting.has(depName)) {
        throw new Error(`Circular dependency detected: ${depName} is part of a cycle`);
      }
    }

    const firstLevelRequired = flattenDeps(meta.dependencies, 'required', index, rootPackageName);
    for (const node of firstLevelRequired) {
      const subMeta = await fetchMeta(node.name);
      await visit(node.name, subMeta);
      if (!resolved.has(node.name)) {
        resolved.set(node.name, node);
      }
    }
  }

  const recommended: DependencyNode[] = meta.dependencies
    ? flattenDeps(meta.dependencies, 'recommended', index, rootPackageName)
    : [];

  return {
    required: Array.from(resolved.values()),
    recommended,
  };
}
