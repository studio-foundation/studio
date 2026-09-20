---
name: bump-version
description: Use when releasing Studio to npm — choosing the next version number, bumping the monorepo, publishing the packages, or cutting the GitHub release.
---

# Bump Version

Studio uses unified versioning: the root and all 6 packages always share one number. The level is derived from the commits since the last **published npm version**, never from git tags — a burned tag is not evidence a version shipped.

**Publish before you release.** Releases are immutable in this repo: a tag name stays reserved forever, even after its release is deleted. A GitHub release cut before npm accepts the packages destroys that version number permanently. `v0.5.0` and `v0.5.1` were both lost this way.

## 1. Find the real baseline

```bash
npm view @studio-foundation/cli version          # last PUBLISHED version
git log --oneline --no-merges "v$(npm view @studio-foundation/cli version)..HEAD"
```

If no tag matches the published version (it may have been deleted), fall back to the last tag that does exist, and say which baseline you used.

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
git checkout main && git pull
git checkout -b chore/bump-X.Y.Z
pnpm version:bump X.Y.Z    # rewrites all 7 package.json — never hand-edit one
pnpm build
```

Add the version's section to `CHANGELOG.md` in the same commit — grouped by area, same
grouping the release notes will use, newest first, dated with the day it publishes. The
changelog is the record for anyone who isn't browsing GitHub releases; written at bump
time it stays a one-minute job, deferred it never happens.

Commit as `chore: bump version to X.Y.Z` with `git commit -s`, open the PR, wait for
merge. The bump and its changelog entry ride alone — no source changes in the same PR.

## 4. Publish, then verify

After the bump PR merges:

```bash
gh run list --workflow npm-publish.yml --limit 3   # a dispatch may already be running or done
gh workflow run npm-publish.yml -f version=X.Y.Z
gh run watch <run-id> --exit-status
```

A failed publish costs nothing — fix and re-run the same version. Never cut the release to "retry" a publish. But dispatch once: a second run after a successful one fails with `E409 Cannot publish over previously staged version` on the first per-platform package. That failure is harmless (nothing new is published), but it means the first run already shipped.

Verify all 14 landed before going further — the 6 core packages and the per-platform `cli-*` binaries `scripts/platforms.mjs` names:

```bash
for p in contracts anonymizer ralph runner engine cli \
  $(node -e 'import("./scripts/platforms.mjs").then(m=>console.log(Object.keys(m.PLATFORMS).map(k=>"cli-"+k).join(" ")))'); do
  echo "$p $(npm view @studio-foundation/$p@X.Y.Z version 2>&1 | tail -1)"
done
```

## 5. Cut the release — draft, attach binaries, then publish

Only once npm shows all 14. Releases are **immutable** in this repo: a published release
rejects asset uploads with `HTTP 422: Cannot upload assets to an immutable release`, and
the tag can never be reused. So the standalone binaries must land while the release is
still a draft.

The notes are the `CHANGELOG.md` section written at step 3, expanded — grouped by area
(Distribution, Preflight, CLI, Engine, Fixes, Docs), not a commit dump. Then:

```bash
gh release create vX.Y.Z --target main --title "vX.Y.Z" --draft --notes-file notes.md
gh workflow run release-binaries.yml -f tag=vX.Y.Z
gh run watch <run-id> --exit-status
gh release edit vX.Y.Z --draft=false --latest
```

Before that last line, prove the assets are complete — the release is immutable once
published, so a missing binary cannot be added afterwards. Do not count them by hand;
`scripts/platforms.mjs` is what the build reads, so ask it — **from a checkout that has the
code being released**, which is usually the bump worktree, not the main checkout:

```bash
diff <(gh release view vX.Y.Z --json assets --jq '.assets[].name' | sort) \
     <(node -e 'import("./scripts/platforms.mjs").then(m=>console.log([...Object.keys(m.PLATFORMS).map(m.assetName),"SHA256SUMS"].sort().join("\n")))')
```

`install.sh` and `install.ps1` download `studio-<platform>` and `SHA256SUMS` from the
release, so a release published without assets leaves those install paths broken for that
version.

## Common mistakes

- **Reading the baseline from `git tag`.** Tags exist for versions that never published. Ask npm.
- **Cutting the release first.** Burns the version if publish fails. Publish is the gate.
- **Publishing the release before the binaries are attached.** Immutable releases reject
  asset uploads once published, and the tag is spent. Draft first.
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
- **Reading a fresh publish through one endpoint.** `npm view <pkg>@X.Y.Z` can answer `E404`
  for minutes after a publish the workflow reported as successful — it is CDN cache, not a
  partial publish. The registry document
  (`curl -s https://registry.npmjs.org/@studio-foundation/<pkg> | jq '.versions["X.Y.Z"] != null'`)
  lags too, and for longer: `runner` and the removed `api` read `false` for a few minutes
  on 0.18.0 to 0.20.0, and `ralph` read `false` for over ten minutes on 0.24.0 while
  `npm view` already answered `X.Y.Z`. Trust whichever says yes: one endpoint answering
  with the version is proof, the other saying no is lag. The publish step's own log
  (`+ @studio-foundation/<pkg>@X.Y.Z`) settles it if both stay silent.
- **npm token expiry.** Granular tokens cap at 90 days and fail only at publish time. A `403` mentioning 2FA means the token lacks the bypass flag; a `404` on `PUT` means it is expired or unscoped.
