# STU-202 — Registry Dependency Resolution

**Date:** 2026-02-28
**Ticket:** [STU-202](https://linear.app/studioag/issue/STU-202/studio-implementer-la-resolution-de-dependances-dans-studio-registry)
**Status:** Approved

## Context

The community registry (`studio-community`) already exposes a `dependencies` field in `metadata.json` and `index.json` (STU-201, done). Studio core must now consume this field to resolve and install dependencies automatically.

Example `dependencies` from registry:

```json
"dependencies": {
  "tools":  { "required": ["repo-manager", "shell", "search", "git"] },
  "agents": { "required": ["coder", "analyst", "publisher", "reviewer"] },
  "skills": { "recommended": ["code-conventions", "git-workflow"] }
}
```

## Design Decisions

- **Architecture:** New `cli/src/registry/resolver.ts` module (follows pattern of `client.ts`, `cache.ts`, `lockfile.ts`)
- **Remove orphans:** Prompt + auto-remove cascade
- **Transitive recommended:** Prompt only at first level; recommended deps of deps are ignored
- **Version conflicts:** last-write-wins (v1 scope)

## Type Changes — `cli/src/registry/types.ts`

Add `PackageDependencies` interface:

```ts
export interface PackageDependencies {
  tools?:     { required?: string[]; recommended?: string[] };
  agents?:    { required?: string[]; recommended?: string[] };
  skills?:    { required?: string[]; recommended?: string[] };
  templates?: { required?: string[]; recommended?: string[] };
  pipelines?: { required?: string[]; recommended?: string[] };
}
```

Extend `PackageMetadata`:

```ts
export interface PackageMetadata extends PackageEntry {
  requires_binaries?: string[];
  dependencies?: PackageDependencies;   // ← new
}
```

Extend `LockfileEntry`:

```ts
export interface LockfileEntry {
  version: string;
  type: PackageType;
  installed_at: string;
  sha256: string;
  required_by?: string[];   // ← new: package names that depend on this
}
```

## Lockfile Changes — `cli/src/registry/lockfile.ts`

Add `addRequiredBy(name, requiredBy)` method — appends to `required_by` without overwriting:

```ts
async addRequiredBy(name: string, requiredBy: string): Promise<void>
```

## New Module — `cli/src/registry/resolver.ts`

```ts
export interface DependencyNode {
  name: string;
  type: PackageType;
}

export interface ResolvedGraph {
  required: DependencyNode[];       // install automatically (recursive)
  recommended: DependencyNode[];    // prompt user (first level only)
}

export async function resolveDependencies(
  rootPackageName: string,
  meta: PackageMetadata,
  index: RegistryIndex,
  lockfile: Lockfile,
): Promise<ResolvedGraph>
```

**Algorithm:**

1. Extract first-level `required` and `recommended` from `meta.dependencies` (flatten across all type keys)
2. For each `required` dep, resolve recursively:
   - Track visiting set for cycle detection → throw `Error` with clear message on cycle
   - Skip if already in resolved set (deduplication)
   - Fetch sub-metadata from registry client to get transitive required deps
3. `recommended` from first level only — no recursion, no transitive chasing
4. Return `{ required, recommended }` — both lists exclude packages already in lockfile that have up-to-date `required_by`

Helper: `flattenDeps(deps: PackageDependencies, index: RegistryIndex): DependencyNode[]` — extracts names from all type keys and looks up `PackageType` in index.

## Install Flow — `cli/src/commands/registry/install.ts`

Updated `installPackage()` flow:

```
1. Fetch metadata → if meta.dependencies:
     call resolveDependencies()

2. Install root package (existing logic)
   → lockfile.add(name, { ..., required_by: [] })

3. For each dep in resolved.required:
   → if already installed:
       lockfile.addRequiredBy(dep.name, rootPackageName)   // update only
     else:
       installPackage(dep.name, { studioDir, requiredBy: rootPackageName })
       → lockfile.add(dep.name, { ..., required_by: [rootPackageName] })

4. If resolved.recommended.length > 0:
   → prompt: "Install recommended packages? [name1, name2] (Y/n)"
   → if Y: installPackage each (no required_by tracking for recommended)
```

**Terminal output:**

```
Installing software-full v2.1.0 [template]...
✓ Installed software-full v2.1.0
  Installing dependency: repo-manager v1.0.0 [tool]...
  ✓ Installed repo-manager v1.0.0
  Installing dependency: shell v1.0.0 [tool]...
  ✓ Installed shell v1.0.0
Install recommended packages? [code-conventions, git-workflow] (Y/n)
```

## Remove Flow — `cli/src/commands/registry/remove.ts`

Updated `removePackage()` flow:

```
1. lockfile.get(name) → entry
   if entry.required_by?.length > 0:
     throw Error: "'name' is required by: [pkg1, pkg2]. Remove them first."

2. Delete files (existing logic)
   lockfile.remove(name)

3. Find orphans:
   for each lockfile entry where required_by includes name:
     remove 'name' from required_by
     if required_by is now [] → orphan candidate

4. If orphans found:
   prompt: "These packages are no longer needed: [dep1, dep2]. Remove them? (Y/n)"
   if Y: removePackage(orphan) for each (recursive)
   if N: log warning "Packages left installed: [dep1, dep2]"
```

## Tests

### `cli/src/registry/resolver.test.ts`
- Simple graph (1 level of deps)
- Recursive resolution (A → B → C)
- Deduplication (A and B both require C → C appears once)
- Cycle detection (A → B → A → throws with clear message)
- Recommended at first level only (dep's recommended ignored)
- Already-installed packages excluded from required list

### `cli/src/commands/registry/install.test.ts`
- Install without deps → unchanged behavior
- Install with required deps → all installed automatically
- Install with recommended deps → prompt shown; Y installs, N skips
- Already-installed dep → `required_by` updated, not reinstalled

### `cli/src/commands/registry/remove.test.ts`
- Remove package with no dependents → direct removal
- Remove package with `required_by` → explicit error
- Remove with orphans → Y prompt → cascade removal
- Remove with orphans → N prompt → warning, nothing removed

## Files Changed

| File | Change |
|------|--------|
| `cli/src/registry/types.ts` | Add `PackageDependencies`, extend `PackageMetadata` and `LockfileEntry` |
| `cli/src/registry/lockfile.ts` | Add `addRequiredBy()` method |
| `cli/src/registry/resolver.ts` | New file — dependency resolution logic |
| `cli/src/commands/registry/install.ts` | Integrate resolver, handle required/recommended |
| `cli/src/commands/registry/remove.ts` | Add required_by check + orphan cleanup |
| `cli/src/registry/resolver.test.ts` | New test file |
| `cli/src/commands/registry/install.test.ts` | New/updated tests |
| `cli/src/commands/registry/remove.test.ts` | New/updated tests |

## Out of Scope

- Complex version conflict resolution
- Private registry
- Transitive recommended dependencies
