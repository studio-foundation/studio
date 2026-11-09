---
name: bump-version
description: Use when releasing Studio — choosing the next version number, bumping the monorepo, and cutting the GitHub release with its binaries
---

# Bump Version

Studio uses unified versioning: the root and all 6 packages always share one number. The level is derived from the commits since the last **published GitHub release**, never from git tags — a burned tag is not evidence a version shipped.

Studio ships as GitHub Release binaries only. npm stopped at 0.29.0 (its token expires every 90 days and the passkey blocks automating a renewal), and its publish workflow was removed.

**The release is the publish.** Releases are immutable in this repo: a published release rejects asset uploads, and a tag name stays reserved forever, even after its release is deleted. A release published with a missing binary cannot be fixed, only skipped. `v0.5.0` and `v0.5.1` were burned this way. So the order is: draft, attach binaries, prove the asset list, then publish.

## 1. Find the real baseline

```bash
gh release list --limit 1 --json tagName,isDraft,publishedAt     # last PUBLISHED release
git log --oneline --no-merges "<tagName>..origin/main"
```

If the tag was deleted or never matched a release, fall back to the last tag that exists, and say which baseline you used.

## 2. Classify the level

Read every commit. The **highest** matching row wins.

| Level | Criteria — any one is sufficient |
|---|---|
| **MINOR** `0.5.2 → 0.6.0` | A new capability reachable from YAML or the CLI (new stage type, new contract key, new command/flag, new tool). **Or** any breaking change: a config key removed or renamed, a default changed, an output shape changed, a previously-accepted config now rejected. |
| **PATCH** `0.5.2 → 0.5.3` | Only backward-compatible bug fixes, plus docs/CI/test-only commits. Every existing `.studio/` config keeps working untouched. |
| **MAJOR** `0.x → 1.0.0` | **Never derived from commits.** See CLAUDE.md § *When Studio goes 1.0* for the criteria and the tripwire that opens the question. If it hasn't fired, propose MINOR and say why. |

Pre-1.0, a breaking change earns MINOR, not MAJOR. That is deliberate — do not "upgrade" it.

Commits that look like features but are not: test-only fixes, CI changes, dependency bumps, docs. A `feat:` prefix is a claim, not proof — check what the commit actually changed.

State the proposed level with the specific commits that justify it, then confirm before bumping.

## 3. Bump

```bash
git fetch origin
git worktree add --no-track -b chore/bump-X.Y.Z .worktrees/bump-X.Y.Z origin/main
pnpm version:bump X.Y.Z    # rewrites all 7 package.json — never hand-edit one
pnpm build
```

Add the version's section to `CHANGELOG.md` in the same commit — grouped by area, same
grouping the release notes will use, newest first, dated with the day it publishes. The
changelog is the record for anyone who isn't browsing GitHub releases; written at bump
time it stays a one-minute job, deferred it never happens.

Commit as `chore: bump version to X.Y.Z` with `git commit -s`, open the PR, wait for
merge. The bump and its changelog entry ride alone — no source changes in the same PR.

## 4. Draft the release, attach the binaries, then publish it

Only after the bump PR has merged. The notes are the `CHANGELOG.md` section written at
step 3, expanded — grouped by area, not a commit dump — and they open with an upgrade
section when a **Breaking** entry exists.

```bash
gh release create vX.Y.Z --target main --title "vX.Y.Z" --draft --notes-file notes.md
gh workflow run release-binaries.yml -f tag=vX.Y.Z
gh run watch <run-id> --exit-status
```

Before publishing, prove the assets are complete — the release is immutable once
published, so a missing binary cannot be added afterwards. Do not count them by hand;
`scripts/platforms.mjs` is what the build reads, so ask it, from a checkout that has the
code being released:

```bash
diff <(gh release view vX.Y.Z --json assets --jq '.assets[].name' | sort) \
     <(node -e 'import("./scripts/platforms.mjs").then(m=>console.log([...Object.keys(m.PLATFORMS).map(m.assetName),"SHA256SUMS"].sort().join("\n")))')
```

No output means complete. Then:

```bash
gh release edit vX.Y.Z --draft=false --latest
```

`install.sh` and `install.ps1` download `studio-<platform>` and `SHA256SUMS` from the
release, so a release published without assets leaves those install paths broken for that
version.

## Common mistakes

- **Reading the baseline from `git tag`.** Tags exist for versions that never published. Ask `gh release list`.
- **Publishing the release before the binaries are attached.** Immutable releases reject
  asset uploads once published, and the tag is spent. Draft first, diff the assets, then publish.
- **A stale runner label.** A matrix entry naming a retired runner (`macos-14` on 2026-11-08)
  never gets a machine: the job is cancelled with `The configuration '…' is not supported`
  and the jobs behind it are skipped. Use `macos-latest`. Nothing is published by a
  cancelled run, so a re-dispatch after the fix is safe.
- **Third-party actions blocked at startup.** The repo allows GitHub-owned actions plus an
  explicit pattern list; a workflow using anything else dies with `startup_failure` and no
  job logs. Check `gh api repos/studio-foundation/studio/actions/permissions/selected-actions`.
- **Calling a breaking change MAJOR.** Pre-1.0, breaking is MINOR.
- **Hand-editing one `package.json`.** Use `pnpm version:bump`; all 7 move together.
- **Bumping inside a feature PR.** Bumps are their own commit, at release time.
- **Shipping a version with no `CHANGELOG.md` entry.** Write it in the bump commit; after the release is cut nobody comes back for it.
- **Committing the bump without a sign-off.** The DCO check blocks the merge on any commit
  with no `Signed-off-by` trailer matching its author, so an unsigned bump costs a
  force-push on the one branch you least want to rewrite. `git commit -s`.
- **Dropping `linux-x64-baseline` from a release.** The x64 binary assumes AVX2, and
  `install.sh` sends every CPU without it to the baseline asset.
