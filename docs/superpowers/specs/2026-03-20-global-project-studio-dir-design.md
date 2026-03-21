# Design — Global vs Project `.studio/` separation

**Date:** 2026-03-20
**Status:** Approved
**Packages touched:** `@studio/cli` only

## Problem

`findStudioDir(startDir)` walks up the directory tree from `startDir` until it finds `.studio/`. If `~/.studio/` exists (global install or prior `studio init` without a project), it gets found when running any `studio` command from anywhere under `$HOME`. This causes the error "Studio is already initialized at ~/.studio" when trying to init a project.

## Solution

Separate global config (`~/.studio/`) from project config (`.studio/` in project tree) — the same model as Claude Code (`.claude/` global vs `.claude/` project) and git (`~/.gitconfig` vs `.git/config`).

## Design

### `studio-dir.ts` — Two distinct functions

Replace the single `findStudioDir` with two explicit functions:

```typescript
/**
 * Walk up from startDir looking for .studio/, stopping BEFORE os.homedir().
 * Returns the absolute path to the project's .studio/, or null if not found.
 *
 * Stop condition: parent === current (filesystem root) OR current === os.homedir().
 * ~/ itself is never checked — so ~/.studio/ is never returned by this function.
 *
 * Example: startDir = ~/projects/foo/src
 *   Checks: ~/projects/foo/src, ~/projects/foo, ~/projects — stops before ~/
 *   A project at ~/my-project/.studio/ IS found when starting from ~/my-project/src/,
 *   because ~/my-project !== ~/. Only $HOME itself is excluded.
 */
export async function findProjectStudioDir(startDir: string): Promise<string | null>

/**
 * Returns the absolute path to ~/.studio/ if it exists, null otherwise.
 * This is the global config location — never a project.
 */
export async function findGlobalStudioDir(): Promise<string | null>
```

**`findStudioDir` (existing):** Kept as a `@deprecated` alias to `findProjectStudioDir` to avoid breaking existing imports. No removal timeline set — remove when all callers are migrated.

### `config.ts` — Merge strategy

`loadConfig` loads both sources and deep-merges them:

1. **Global first:** load `~/.studio/config.yaml` via `findGlobalStudioDir()` → base config
2. **Project override:** load `.studio/config.yaml` via `findProjectStudioDir()` → merge on top
3. **`resolvedStudioDir`:** points to project `.studio/` if found, else `~/.studio/` if found, else undefined

**Merge rules by field:**

| Field | Strategy |
|-------|----------|
| `providers` | Shallow merge at provider level — project's `anthropic` entirely replaces global's `anthropic`. Within a provider object, all fields come from one source (no deep merge). |
| `defaults` | Project overrides global entirely |
| `api` | Project overrides global entirely |
| `db` | Project overrides global entirely |
| `paths` | Project overrides global entirely |
| `integrations` | Shallow merge at integration key level — project's `linear` entirely replaces global's `linear` |

**Legacy fallback (`.studiorc.yaml` / `.studiorc.yml`):** Only applies when **neither** global (`~/.studio/`) nor project (`.studio/`) is found. Checked at `cwd` only. Not affected by the merge logic.

**`resolvedStudioDir` and write operations:**

`resolvedStudioDir` tells callers where to write (e.g., `studio config set`). Its value determines write target:

- Project `.studio/` found → writes go to project `.studio/config.yaml`
- Only global `~/.studio/` found → writes go to `~/.studio/config.yaml`
- Neither found → commands that require a studio dir should error with "No .studio/ found. Run `studio init` first."

This means `studio config set provider anthropic` from a project directory writes to the project config, not global — which is the expected behavior.

**Special cases:**
- `configPath` explicit → short-circuits everything (unchanged behavior)
- Neither global nor project exists → returns `{}` (unchanged behavior)

### Typical usage

```
~/.studio/config.yaml          # API keys, default provider (global, gitignored)
my-project/.studio/config.yaml # Override defaults, project-specific settings
```

A developer sets API keys once globally. Projects inherit them and can override `defaults.provider` or `defaults.model` without re-declaring keys.

## Tests

All in `cli/tests/studio-dir.test.ts` and `cli/tests/config.test.ts`:

**`findProjectStudioDir`:**
- Stops before `~` when `~/.studio/` exists (main regression test)
- Finds `.studio/` walking up a project tree
- Finds `.studio/` in a project directly under `$HOME` (e.g., `~/my-project/.studio/`)
- Returns null when no project `.studio/` exists (global-only case)

**`findGlobalStudioDir`:**
- Returns `~/.studio/` when present
- Returns null when `~/.studio/` absent

**`loadConfig` merge:**
- Global + project: project keys win, global keys fill the rest
- Global only: returns global config, `resolvedStudioDir` = `~/.studio/`
- Project only: returns project config, `resolvedStudioDir` = project `.studio/`
- Neither: returns `{}`, `resolvedStudioDir` = undefined
- Legacy fallback still triggers when neither `.studio/` exists
- `providers` merge: project provider replaces global provider entirely
- `integrations` merge: project integration replaces global integration entirely

## Migration

Zero breaking change for users. An existing `~/.studio/` automatically becomes the global config — no migration command needed.
