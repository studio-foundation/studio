# ADR 0001 — Distribution model: marketplace of pointers, not content monorepo

**Status:** Accepted
**Date:** 2026-07-27
**Affects:** `studio-community`, `cli/src/registry/`

---

## Context

`studio-community` is currently a content monorepo. Every package's payload lives inside
the repo. Publishing means opening a pull request that merges YAML into `main`. The CLI
resolves a package by building a `raw.githubusercontent.com` URL from the package name.

This works today because every package is first-party and there are no external
contributors. It does not survive the first one.

Three clauses of [GOVERNANCE.md](../../GOVERNANCE.md) are in tension with the monorepo shape:

- *"Redistribution rather than centralization"* — every package in the world would pass
  through a single `main` branch controlled by one person.
- *"Studio is designed so that it cannot be captured"* — the kernel is AGPL and
  non-capturable, but whoever controls `studio-community` controls what is installable.
  The engine is hardened and the distribution point is not.
- *"The founder can step back without the system collapsing"* — a content monorepo
  requires a maintainer to merge, permanently.

The charter already contains the correct analogy: *"as GitHub, GitLab, and Bitbucket are
to `git`: products built on a free tool without authority over it."* A content monorepo
makes `studio-community` the GitHub of Studio. A marketplace makes it one remote among
many.

## Decision

Studio distributes packages through **marketplaces of pointers**. A marketplace is a git
repository containing an index that references package payloads; the payloads themselves
may live anywhere.

An index entry declares its source:

```json
{
  "name": "git",
  "type": "plugin",
  "version": "1.0.0",
  "license": "MIT",
  "source": { "type": "local", "path": "plugins/git" }
}
```

```json
{
  "name": "legal-analysis",
  "type": "template",
  "version": "2.1.0",
  "license": "AGPL-3.0",
  "source": {
    "type": "git",
    "url": "https://github.com/someone/studio-legal.git",
    "path": "template",
    "ref": "v2.1.0",
    "sha": "9f3c1a…"
  }
}
```

`local` means the payload is in the marketplace repo itself. `git` means it lives in the
author's repo. Both resolve through the same code path; only the fetch differs.

Users may register additional marketplaces:

```
git remote add <url>   →   studio marketplace add <url>
```

`studio-community` becomes the default marketplace, not the only one. Private company
marketplaces work with no hosted service and no fork.

## Consequences

**The name→URL derivation disappears.** `source.path` is explicit. The class of bug where
a package directory name diverges from its `metadata.json` name and produces a 404
(STU-423) becomes unrepresentable.

**License enforcement weakens.** In a content monorepo, "all packages must be open
source" is verified by reading the diff at merge time. With `git` sources, review sees a
URL. The author can relicense, close the repo, or redirect after acceptance.

Mitigations, none of which fully close the gap:

- `license` is required on every index entry.
- CI fetches `git` sources and asserts a LICENSE file matching the declared license.
- Entries pin `sha`, not only `ref`, so an upstream change does not propagate silently.
- Delisting is the ultimate lever, and it stays sufficient.

The residual risk is accepted. It is the same risk every package registry carries, and it
is smaller than the centralization risk it replaces.

**Download counts require a service.** A static index cannot count installs. `downloads`
stays at `0` until a hosted component exists, or the field is dropped. This is unchanged
from today.

**Two resolvers, two validation paths.** `local` sources are validated at merge. `git`
sources can only be validated at fetch. CI must handle both.

## Alternatives considered

**Keep the content monorepo.** Zero work, and adequate while the author count is one. It
makes the maintainer a permanent bottleneck, makes private marketplaces impossible, and
leaves the distribution layer as the only part of Studio that behaves like a platform.

**Pure pointer model, no `local` sources.** Cleaner, and matches
`anthropics/claude-plugins-official` exactly. Rejected because it forces every existing
first-party package into a separate repository for no gain — `local` is a legitimate
source type, not a transitional hack.

## Migration

Additive. `scripts/generate-index.mjs` emits `source: {type: "local", path: "<type>/<name>"}`
for every existing package; the CLI reads `source` instead of constructing a URL from
`name`. Nothing breaks. `type: "git"` is a later branch in the same switch.

Implementation of `git` sources is not scheduled by date. Trigger conditions:

- a first external contributor wants to publish while keeping their repository, or
- a first concrete need for a private marketplace.

Per *"Governance before execution — not-acting is a valid decision"*, the decision is
recorded now and built when triggered.

## References

- [GOVERNANCE.md](../../GOVERNANCE.md) — anti-capture mechanisms, cadence
- [ADR 0002](./0002-packaging-model.md) — what a marketplace entry points at
- `anthropics/claude-plugins-official` — `.claude-plugin/marketplace.json` prior art
- STU-79 (architecture), STU-423 (hygiene), STU-203 (versioning)
