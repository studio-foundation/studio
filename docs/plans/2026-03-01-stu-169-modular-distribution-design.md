# STU-169 — Modular Distribution: `studio install api`

**Date:** 2026-03-01
**Branch:** `arianedguay/stu-169-distribution-modulaire-studio-install-api-et-studio-install`

## Problem

`@studio/cli` statically imports `@studio/api`, which means installing the CLI always pulls in the full API server (Fastify, SQLite, etc.). The CLI should be a standalone kernel — like `git` — and the API should be opt-in.

Two concrete pain points:
1. `commands/run.ts` imports `resolveRepoPath` from `@studio/api` (a pure Node.js utility with no server dependencies)
2. `commands/api.ts` statically imports `bootstrap` and `buildServer` from `@studio/api`

## Approach: Dynamic import (Approach A)

Remove `@studio/api` from `cli/package.json` dependencies. Move shared utility to engine. Load the API package at runtime only when needed, failing gracefully if not installed.

## Design

### 1. Package boundaries

- `cli/package.json`: remove `@studio/api` from `dependencies`, add as `devDependency` only (types at build time, not bundled at install time)
- At runtime, `import('@studio/api')` resolves from global node_modules — where `studio install api` puts it

### 2. Move `resolveRepoPath` to `@studio/engine`

- Create `engine/src/repo-resolver.ts` — copy implementation from `api/src/utils/repo-resolver.ts` (only Node.js builtins, zero external deps)
- Export `resolveRepoPath` and `cloneRepo` from `engine/src/index.ts`
- `api/src/utils/repo-resolver.ts` becomes a re-export from `@studio/engine` (all API callers keep their import path)
- `cli/src/commands/run.ts` — change import from `@studio/api` → `@studio/engine`

### 3. `commands/api.ts` — dynamic import + PID file daemon

No static `@studio/api` import. Three handlers:

**`start`**
```
try {
  const { bootstrap, buildServer } = await import('@studio/api');
  // ... start server ...
  // write PID to ~/.studio/api.pid
  // delete PID file on SIGINT/SIGTERM
} catch {
  console.error('API not installed. Run: studio install api');
  process.exit(1);
}
```

**`stop`**
- Read `~/.studio/api.pid`
- Send SIGTERM to that PID
- Delete the PID file

**`status`**
- Read `~/.studio/api.pid` — if missing → "API not running"
- Check process alive via `process.kill(pid, 0)`
- HTTP GET `localhost:{port}/api/health` for confirmation
- Print status + port

### 4. `studio install api` command

New file: `cli/src/commands/install.ts`

```
studio install api
  → execSync('npm install -g @studio/api')
  → success: "✓ @studio/api installed. Run: studio api start"
  → failure: print npm error, exit 1
```

Registered in `cli/src/index.ts` as `studio install <extension>`.

## Acceptance criteria mapping

| Criterion | How addressed |
|-----------|---------------|
| `npm install -g @studio/cli` ne tire pas `@studio/api` | Remove from `dependencies` |
| `studio install api` installe `@studio/api` globalement | New `install` command → `npm install -g` |
| `studio api start/stop/status` fonctionnent après installation | Dynamic import + PID file |
| CLI fonctionne sans API installée | No static imports from `@studio/api` |

## Files changed

| File | Change |
|------|--------|
| `engine/src/repo-resolver.ts` | New — implementation moved from API |
| `engine/src/index.ts` | Add exports for `resolveRepoPath`, `cloneRepo` |
| `api/src/utils/repo-resolver.ts` | Replace with re-export from `@studio/engine` |
| `cli/package.json` | Move `@studio/api` from deps → devDeps |
| `cli/src/commands/run.ts` | Change import to `@studio/engine` |
| `cli/src/commands/api.ts` | Rewrite — dynamic import + PID file daemon |
| `cli/src/commands/install.ts` | New — `studio install api` |
| `cli/src/index.ts` | Add `stop`/`status` to api command, add `install` command |
