# ADR 0002 — Packaging model: templates and plugins

**Status:** Accepted
**Date:** 2026-07-27
**Affects:** `studio-community`, `cli/src/registry/`, `studio init`

---

## Context

`studio-community` publishes seven package types: `tool`, `template`, `pipeline`,
`integration`, `agent`, `plugin`, `skill`. They are listed flat in `index.json`, as if
comparable.

They are not. Two distinct layers are being conflated:

- **Packaging** — what a marketplace distributes and what an install command acts on.
- **Content** — what ends up in `.studio/` and is referenced by name inside YAML
  (`agent: coder`, `tools: [git-commit]`).

`agent` is referenceable from a pipeline. `plugin` never is — it is a delivery vehicle.
Putting both in one list is why `plugin` has zero published packages: it is a packaging
concept sitting in a list of content concepts, so there is nothing obvious to put in it.

The distinction that matters to a user is neither of these. It is: *am I starting from
nothing, or adding to something that exists?*

## Decision

Two packaging types.

|  | `template` | `plugin` |
|---|---|---|
| Target | no `.studio/` yet | existing `.studio/` |
| Verb | `studio init --template X` | `studio plugin add X` |
| Cardinality | one per project, at creation | many, at any time |
| Payload | pipelines, contracts, app scaffold (`package.json`, `prisma/`, `src/`) | any mix of content |

`tool`, `agent`, `contract`, `pipeline`, `skill`, and `integration` stop being package
types. They become **content kinds** carried inside a plugin. A single-file package is a
plugin whose payload happens to be one file — every package already lives in its own
directory with a `metadata.json`, so this adds no ceremony.

Each index entry declares what it delivers:

```json
{
  "name": "git",
  "type": "plugin",
  "provides": { "tools": ["git"], "agents": [], "skills": ["git-workflow"] }
}
```

Search stays granular through `provides`: "find me a git tool" matches the plugin that
provides it. This mirrors `"skills": ["./skill-a", "./skill-b"]` in
`anthropics/claude-plugins-official`.

### Templates depend on plugins

A template declares the plugins it needs. A code-building project needs `git`; the
template supplies the pipelines and contracts, the plugin supplies the tool.

```yaml
# templates/software/metadata.json
dependencies:
  plugins:
    required: ["git", "coder", "reviewer"]
    recommended: ["github"]
```

Templates do not vendor what a plugin already provides. This is already how the repo
behaves — `templates/software/project/` ships pipelines and contracts but no agents, and
`feature-builder.pipeline.yaml` references `agent: coder`, resolved through
`metadata.dependencies.agents.required` and checked by
`scripts/validate-templates.mjs`. The decision generalizes an existing mechanism rather
than inventing one.

Four sub-decisions follow:

**Resolution happens at init.** `studio init --template software` fetches and installs
required plugins before writing the project. `init` becomes a resolver, not a file copier.
Recommended plugins are prompted.

**Cross-marketplace dependencies are allowed, but must be explicit.** An unqualified name
resolves within the template's own marketplace. Another marketplace is named inline:

```yaml
required: ["git", "acme-corp:internal-deploy"]
```

Forbidding cross-marketplace dependencies (the `claude-plugins-official` position) would
mean a community template can never depend on a community plugin, which contradicts the
premise that anyone can build around the engine. The cost is that a dependency can point
at a marketplace the user has not registered; the resolver prompts to add it, and
declines rather than adding silently.

**Version constraints are ranges, resolved greedily.** Dependencies declare `>=X.Y.Z`.
The resolver picks the highest available version satisfying every constraint, and fails
with the conflicting pair when none does. No SAT solving, no lockfile-driven backtracking.
This is the minimum that makes STU-203 tractable; it can be strengthened later without a
format change.

**Removing a depended-upon plugin warns, does not block.** `studio plugin remove git`
when a pipeline references `git-commit` prints which references break and proceeds.
Studio validates tool availability at run time; a second gate at removal time would be
enforcement without authority, and would make cleanup hostile.

Plugins may depend on plugins, through the same mechanism.

## Consequences

**Fifteen existing packages migrate to `type: "plugin"`.** Mechanical: fifteen
`metadata.json` edits plus a `provides` block, and a change to
`scripts/generate-index.mjs`. `studio registry install git` must keep working — resolution
is by name, not by type, so the command is unaffected.

**`index.json` loses type-based grouping.** `studio registry browse` currently groups by
the seven types. It regroups by tag, or by `provides` kind.

**The marketplace entry shape stabilizes.** Two forms, each defined by its install verb.
This is the precondition for external authors to point at it — an unstable unit cannot be
depended upon.

**`provides` becomes a trust lever.** With `git` sources (ADR 0001), CI can fetch a
plugin and assert it delivers exactly what it declares. A content monorepo did not need
this; a pointer model does.

## Alternatives considered

**Three tiers: template / plugin / component.** No migration, and it keeps "install one
file" visibly distinct from "install a bundle". Rejected: the boundary is arbitrary — at
how many files does a component become a plugin? — and the two have identical install
semantics, so the distinction buys nothing. It also leaves `component` as a catch-all for
five heterogeneous subtypes, which is the current problem renamed.

**Keep seven flat types.** Zero work. Leaves the packaging/content conflation in place,
which is what produced an unused `plugin` type and an undocumented overlap with
`template`.

**Self-contained templates, no dependencies.** Simpler resolver, no version constraints,
no cross-marketplace question. Rejected: it forces every template to vendor its own copy
of common tools and agents, so a fix to `git` has to be applied in every template that
embedded it.

## References

- [ADR 0001](./0001-distribution-model.md) — how marketplace entries are sourced
- [GOVERNANCE.md](../../GOVERNANCE.md) — templates as architectural patterns
- `scripts/validate-templates.mjs` in `studio-community` — existing dependency check
- STU-79 (architecture), STU-203 (versioning and dependency resolution)
