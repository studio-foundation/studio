# GitHub Actions CI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a GitHub Actions workflow that runs build, typecheck, and tests on every PR and push to `main`.

**Architecture:** One workflow file with 3 jobs — `build` as a gate, then `typecheck` and `test` in parallel (both `needs: [build]`). Each job re-runs install+build using the cached pnpm store. No artifact passing needed.

**Tech Stack:** GitHub Actions, pnpm 10, Node 22, vitest, tsc

---

### Task 1: Create the CI workflow file

**Files:**
- Create: `.github/workflows/ci.yml`

**Step 1: Create the `.github/workflows/` directory and file**

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    name: Build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build all packages
        run: pnpm build

  typecheck:
    name: Typecheck
    needs: [build]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build all packages
        run: pnpm build

      - name: Typecheck all packages
        run: pnpm -r --if-present run typecheck

  test:
    name: Test
    needs: [build]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build all packages
        run: pnpm build

      - name: Run tests
        run: pnpm test
```

**Step 2: Verify the file is valid YAML**

Open `.github/workflows/ci.yml` and visually confirm the indentation is consistent (YAML is whitespace-sensitive).

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow (build + typecheck + test)"
```

**Step 4: Push and verify the workflow triggers**

```bash
git push origin <your-branch>
```

Then open the repo on GitHub → Actions tab. You should see the `CI` workflow appear within ~30s. Check that all 3 jobs run and pass.

Expected first-run behavior:
- `build`: ~2-3 min (cold pnpm cache)
- `typecheck` + `test`: start after build, ~2-3 min each (cold cache)
- Total wall time: ~5 min first run, ~2-3 min subsequent runs (warm cache)

If `test` fails: check if any tests depend on environment (e.g., filesystem paths). The `--frozen-lockfile` flag ensures CI uses exactly the versions in `pnpm-lock.yaml`.

---

## Notes

- `--if-present` on typecheck: `anonymizer` and `runner` don't have a `typecheck` script. Without this flag, pnpm errors on those packages.
- `pnpm/action-setup@v4` with explicit `version: 10` pins the pnpm version used in CI to match local.
- `actions/setup-node@v4` with `cache: 'pnpm'` automatically caches `~/.local/share/pnpm/store` keyed on `pnpm-lock.yaml` hash.
- Re-running `pnpm build` in typecheck and test jobs (instead of passing artifacts) keeps config simple. With warm cache, it adds ~30s per job.
