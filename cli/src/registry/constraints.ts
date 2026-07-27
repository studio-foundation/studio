import semver from 'semver';
import type { LockfileEntry, PackageEntry } from './types.js';

/** A version range one package declares on another. */
export interface Constraint {
  requiredBy: string;
  range?: string;
}

/**
 * Greedy range resolution: the highest indexed version satisfying every
 * constraint. No backtracking — a conflict is reported, not worked around.
 */
export function selectVersion(name: string, constraints: Constraint[], candidates: PackageEntry[]): string {
  const ranged = constraints.filter((c) => c.range);
  if (ranged.length === 0) return candidates[0].version;

  const satisfying = candidates.filter((p) =>
    ranged.every((c) => semver.valid(p.version) !== null && semver.satisfies(p.version, c.range!))
  );

  if (satisfying.length === 0) {
    const available = candidates.map((p) => p.version).join(', ');
    throw new Error(
      `No version of '${name}' satisfies every constraint: ${formatConstraints(ranged)}. Available: ${available}.`
    );
  }

  return satisfying.map((p) => p.version).sort(semver.rcompare)[0];
}

/** The ranges recorded against an installed package, one per dependent. */
export function constraintsOf(entry: LockfileEntry): Constraint[] {
  return Object.entries(entry.constraints ?? {}).map(([requiredBy, range]) => ({ requiredBy, range }));
}

/** The constraints a version breaks. A non-semver version is unverifiable, not broken. */
export function unsatisfied(version: string, constraints: Constraint[]): Constraint[] {
  if (semver.valid(version) === null) return [];
  return constraints.filter((c) => c.range && !semver.satisfies(version, c.range));
}

export function formatConstraints(constraints: Constraint[]): string {
  return constraints.map((c) => `'${c.range}' (required by ${c.requiredBy})`).join(', ');
}
