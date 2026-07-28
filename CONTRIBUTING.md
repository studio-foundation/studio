# Contributing to Studio

Studio is a commons. Contributions are welcome — bug reports, fixes, tool plugins,
templates, documentation. This file describes what a mergeable contribution looks like.

Read [GOVERNANCE.md](./GOVERNANCE.md) first if you want to know *why* the project is
shaped this way. Read [INVARIANTS.md](./INVARIANTS.md) before touching the kernel.

---

## Sign your commits (DCO)

Studio uses the [Developer Certificate of Origin](./DCO), not a CLA. You keep the
copyright on what you write; you certify that you have the right to submit it under
AGPL-3.0. Nothing is assigned to anyone — see
[ADR 0003](./docs/adr/0003-contribution-rights.md).

Every commit must carry a `Signed-off-by` trailer matching its author:

```bash
git commit -s -m "fix(engine): stop double-counting retry attempts"
```

which appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

Forgot? Fix the whole branch at once:

```bash
git rebase --signoff main
```

CI checks this on every pull request ([`.github/workflows/dco.yml`](./.github/workflows/dco.yml)).
A PR with an unsigned commit does not merge.

## Before you write code

**Open an issue first for anything structural.** Bug fixes and documentation can go
straight to a PR. A new YAML key, a new CLI command, a new package boundary, or anything
that changes what a `.studio/` config author can write should be discussed in an issue
before you build it — governance comes before execution, and "no" is a valid answer.

**Check the invariants.** [INVARIANTS.md](./INVARIANTS.md) is the constitution of the
kernel. Two you will hit immediately:

- **The engine is domain-agnostic** (INV-11). No `code`, `file`, `git`, or `QA` concept in
  the kernel. Domain tools are marketplace plugins.
- **The dependency graph is a DAG** (INV-10). `contracts` is a leaf; `ralph`, `runner` and
  `anonymizer` depend only on it; `engine` depends on those; `cli` and `api` depend on
  `engine`. An upward import is an architecture error, and ESLint rejects it.

**Prefer YAML over code.** If a feature can be expressed in a `.tool.yaml`, a contract, or
a pipeline instead of TypeScript, it belongs in YAML. This is a rule, not a preference.

## Development setup

Requires Node 22+ and pnpm 10.

```bash
pnpm install          # one install at the root, for all 7 packages
pnpm build            # builds in dependency order
pnpm test
pnpm lint             # blocking in CI
pnpm check:kernel     # INV-11: the kernel names no domain tool
```

Run the CLI from a checkout with `node cli/dist/index.js`, or `pnpm --filter @studio-foundation/cli build && npm link`.

Useful while debugging:

```bash
studio run <pipeline> --provider mock     # no API key needed
studio run <pipeline> --live              # real-time tool calls
DEBUG=studio:* studio run <pipeline>
```

## Commits and branches

- Branch off `main`. Never push to `main`.
- [Conventional commits](https://www.conventionalcommits.org/): `feat(runner): …`,
  `fix(engine): …`, `docs: …`, `chore: …`, `test: …`, `refactor: …`.
- One logical change per commit. Don't batch unrelated fixes.
- **Do not touch the version.** Studio uses unified versioning across the 8
  `package.json` files, bumped in a dedicated release commit — never in a feature PR.

## Pull requests

Describe **what** changed, **why**, which **packages** are touched, and **how to test**.

Checklist:

- [ ] Every commit is signed off (`git commit -s`)
- [ ] `pnpm build`, `pnpm test`, `pnpm lint` and `pnpm check:kernel` pass
- [ ] No inverted dependency, no new `@studio-foundation/*` import outside the DAG
- [ ] New behaviour has a test
- [ ] Docs updated in the same PR (see below)
- [ ] No version bump

### Docs to update in the same PR

| Change | Doc |
|---|---|
| Package added/removed, dependency edge changed | [CLAUDE.md](./CLAUDE.md) graph, [INVARIANTS.md](./INVARIANTS.md) INV-10, [GOVERNANCE.md](./GOVERNANCE.md) |
| Invariant added or changed | [INVARIANTS.md](./INVARIANTS.md) |
| New CLI command or flag | [CLI.md](./CLI.md) |
| New YAML key a config author can write | [CONCEPTS.md](./CONCEPTS.md) + [CLAUDE.md](./CLAUDE.md) |
| New API route | [API.md](./API.md) + its Swagger schema |
| Template or distribution change | [TEMPLATES.md](./TEMPLATES.md), [GOVERNANCE.md](./GOVERNANCE.md) |
| Builtin tool added or removed | [INVARIANTS.md](./INVARIANTS.md) INV-11, `BUILTIN_TOOLS` in [scripts/check-kernel-domain-free.mjs](./scripts/check-kernel-domain-free.mjs), [CLAUDE.md](./CLAUDE.md) |

A documentation update is part of the change, not a follow-up.

### When an ADR is required

Structural decisions are written down: *a decision without trace did not happen.* Add an
[ADR](./docs/adr/) when a PR changes the distribution or packaging model, a package
boundary, an invariant, the licensing or governance posture, or picks one architecture
over a viable alternative. Copy [docs/adr/template.md](./docs/adr/template.md), number it
next in sequence, and open it in the same PR as the code.

## Tool plugins and templates

Those are not contributions to this repo. Tools, agents, skills, pipelines and templates
are distributed through the marketplace — `studio-community` is the default one:

```bash
studio registry publish <path>
```

Publishing is a PR against the marketplace repo, with no review gate. See
[TEMPLATES.md](./TEMPLATES.md) and [ADR 0001](./docs/adr/0001-distribution-model.md).

## License

Studio is licensed under AGPL-3.0. By contributing, you agree that your contribution is
licensed under the same terms, and you sign off on the [DCO](./DCO). Studio will not be
relicensed — see [ADR 0003](./docs/adr/0003-contribution-rights.md).
