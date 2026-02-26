# GitHub Actions CI — Design

**Date:** 2026-02-25
**Status:** Approved

## Context

The Studio monorepo has no CI pipeline. Each of the 7 packages has `vitest run` and most have `tsc --noEmit` typecheck. There's no linter currently. The repo is public on GitHub, so GitHub Actions minutes are free.

## Goal

Run build, typecheck, and tests automatically on every PR targeting `main` and on every push to `main`.

## Approach: Parallel jobs with build gate

```
build ──→ typecheck ─┐
     └──→ test       ┘ (parallel)
```

Three jobs in one workflow file `.github/workflows/ci.yml`.

## Jobs

### `build`
- Checkout + Node 20 + pnpm
- `pnpm install --frozen-lockfile`
- `pnpm build` (respects dependency order: contracts → anonymizer/ralph/runner → engine → api/cli)

### `typecheck` (needs: build)
- Same install (fast via pnpm store cache)
- `pnpm build` (re-run, fast with cache)
- `pnpm -r --if-present run typecheck` (`--if-present` skips anonymizer/runner which have no typecheck script)

### `test` (needs: build)
- Same install + build
- `pnpm test`

## Cache strategy

`actions/setup-node` with `cache: 'pnpm'` caches the pnpm store keyed on `pnpm-lock.yaml`. Reduces install time from ~60s to ~10s after first run.

## Trigger

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
```

## Trade-offs

- `typecheck` and `test` each re-run install+build. This is intentional — simpler config, no artifact passing. With cache, each job adds ~30s overhead.
- Wall time: ~2-3 min total (build + parallel jobs).
- The `needs: [build]` gate prevents noisy failures: if the build is broken, typecheck/test don't run.
