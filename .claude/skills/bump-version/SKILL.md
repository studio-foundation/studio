---
name: bump-version
description: Use when releasing Studio to npm — choosing the next version number, bumping the monorepo, publishing the packages, or cutting the GitHub release.
---

# Bump Version

Studio uses unified versioning: the root and all 7 packages always share one number. The level is derived from the commits since the last **published npm version**, never from git tags — a burned tag is not evidence a version shipped.

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
| **MAJOR** `0.x → 1.0.0` | **Never derived from commits.** The jump to 1.0 is an explicit product decision. If the user has not said "this is 1.0", it is not 1.0 — propose MINOR and say why. |

Pre-1.0, a breaking change earns MINOR, not MAJOR. That is deliberate — do not "upgrade" it.

Commits that look like features but are not: test-only fixes, CI changes, dependency bumps, docs. A `feat:` prefix is a claim, not proof — check what the commit actually changed.

State the proposed level with the specific commits that justify it, then confirm before bumping.

## 3. Bump

```bash
git checkout main && git pull
git checkout -b chore/bump-X.Y.Z
pnpm version:bump X.Y.Z    # rewrites all 8 package.json — never hand-edit one
pnpm build
```

Commit as `chore: bump version to X.Y.Z`, open the PR, wait for merge. Version bumps ride alone — no source changes in the same PR.

## 4. Publish, then verify

After the bump PR merges:

```bash
gh workflow run npm-publish.yml -f version=X.Y.Z
gh run watch <run-id> --exit-status
```

A failed publish costs nothing — fix and re-run the same version. Never cut the release to "retry" a publish.

Verify all 7 landed before going further:

```bash
for p in contracts anonymizer ralph runner engine api cli; do
  echo "$p $(npm view @studio-foundation/$p@X.Y.Z version)"
done
```

## 5. Cut the release

Only once npm shows all 7. Write the notes grouped by package area (Engine, Contracts, Anonymizer, Providers, CLI, Fixes, Docs), not as a commit dump:

```bash
gh release create vX.Y.Z --target main --title "vX.Y.Z" --latest --notes-file notes.md
```

## Common mistakes

- **Reading the baseline from `git tag`.** Tags exist for versions that never published. Ask npm.
- **Cutting the release first.** Burns the version if publish fails. Publish is the gate.
- **Calling a breaking change MAJOR.** Pre-1.0, breaking is MINOR.
- **Hand-editing one `package.json`.** Use `pnpm version:bump`; all 8 move together.
- **Bumping inside a feature PR.** Bumps are their own commit, at release time.
- **npm token expiry.** Granular tokens cap at 90 days and fail only at publish time. A `403` mentioning 2FA means the token lacks the bypass flag; a `404` on `PUT` means it is expired or unscoped.
