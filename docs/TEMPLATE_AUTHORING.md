# Template Authoring

Specification for authoring Studio templates and for the `studio template validate` CLI. This is contributor-facing. For a user-facing overview of available templates, see [TEMPLATES.md](../TEMPLATES.md).

---

## Template layout

A template is a directory with `metadata.json` at its root and everything it installs under `project/`.

```
<template-name>/
├── metadata.json          # required — see format below
└── project/               # everything installed into the target project
    ├── pipelines/         # *.pipeline.yaml
    ├── contracts/         # *.contract.yaml
    ├── agents/            # *.agent.yaml
    ├── tools/             # *.tool.yaml
    ├── inputs/            # *.input.yaml
    ├── src/               # app scaffold (optional)
    ├── prisma/            # app scaffold (optional)
    ├── package.json       # app scaffold (optional)
    └── README.md          # app scaffold (optional)
```

Only `metadata.json` is enforced. Every directory under `project/` is optional — `studio init` copies whichever ones exist and creates the missing `.studio/` subdirectories empty.

A template does not have to ship its own agents and tools. It can depend on packages published separately in the registry and declare them under `dependencies` (see below); `templates/software` in [studio-community](https://github.com/studio-foundation/studio-community) does exactly that.

---

## `metadata.json` format

```json
{
  "name": "software",
  "version": "1.1.0",
  "description": "Code generation with repo, shell and search tools",
  "author": "studio-core",
  "license": "MIT",
  "tags": ["software", "code", "development"],
  "type": "template",
  "studio_version": ">=0.2.0",
  "dependencies": {
    "tools":  { "required": ["repo-manager", "shell", "search"] },
    "agents": { "required": ["coder"] }
  }
}
```

`name`, `version` and `description` are required — the validator rejects the template without them. `type` and `studio_version` are read by the registry; `studio_version` is a semver range checked by `studio registry install`.

`dependencies` is resolved recursively at install time: every package under `required` is fetched and installed before the template finishes, and each one records the template under `required_by` in the lockfile. Packages under `recommended` prompt for confirmation instead.

---

## Placeholder system

Placeholders use `{{DOUBLE_BRACES}}` and are substituted by `studio init`.

| Placeholder | Value |
|-------------|-------|
| `{{PROJECT_NAME}}` | Project name — the positional argument to `studio init`, else `--project`, else the directory name |
| `{{TEMPLATE_NAME}}` | Name of the source template |
| `{{YEAR}}` | Current year at generation time |

There are no other placeholders. `applyPlaceholders` ([cli/src/utils/placeholders.ts](../cli/src/utils/placeholders.ts)) throws on any `{{ALL_CAPS}}` token it doesn't recognise, which aborts `studio init`.

**Where substitution happens** — only in the contents of the app scaffold (`src/`, `prisma/`, `package.json`, `README.md`) and in the generated `ONBOARDING.md`, and only for known text extensions (`.ts`, `.js`, `.json`, `.md`, `.yaml`, `.yml`, `.prisma`, `.txt`, `.env`, `.gitignore`, `.sh`). Other files are copied byte-for-byte.

**Where it does not** — filenames and directory names are never rewritten, and the `.studio/` subdirectories (`pipelines/`, `contracts/`, `agents/`, `tools/`, `inputs/`) are copied verbatim. A `{{PROJECT_NAME}}` inside a pipeline YAML reaches the generated project unsubstituted.

---

## What `studio init --template <name>` does

1. Downloads the template's `project/` directory from the registry into `.studio/projects/<name>/`.
2. Copies `pipelines/`, `contracts/`, `agents/`, `tools/`, `inputs/` from there into `.studio/`, creating any that the template omits.
3. Copies `src/`, `prisma/`, `package.json`, `README.md` to the project root, applying placeholders.
4. Writes `ONBOARDING.md` at the project root (never overwrites an existing one).
5. Runs `git init` unless the directory is already a repo.

---

## Validation rules

```bash
studio template validate <path>
```

Three levels, each stopping before the next on failure. Point it at the directory holding `metadata.json`.

**Level 1 — Structural:**
- `metadata.json` exists, parses as JSON, and has non-empty `name`, `version` and `description`.

That is the whole level. No file or directory other than `metadata.json` is required.

**Level 2 — Semantic** (parse + cross-reference):
- Every `.yaml`/`.yml` file in `pipelines/`, `agents/`, `contracts/` and `tools/` parses, is non-empty, and is a mapping rather than a list.
- Every pipeline stage's `contract` matches a `<name>.contract.yaml` in `contracts/`.
- Every pipeline stage's `agent` matches a `<name>.agent.yaml` in `agents/`.

Stages nested inside a `group:` are collected and checked like top-level ones.

**Level 3 — Compilation** (only if the files are present):
- `tsconfig.json` present → runs `tsc --noEmit` in the template directory and reports the output as a semantic error on failure.
- `prisma/schema.prisma` present → emits a warning that migration testing is not automated. It is never validated.

> **Known gap — the validator passes on templates it has not read.** It looks for `pipelines/`, `agents/` and `contracts/` beside `metadata.json`, but a registry template keeps them one level down under `project/`. Pointed at such a template it finds no YAML, has nothing to cross-reference, and reports both levels green. All five templates in studio-community validate clean today for that reason, not because their YAML was checked. Tracked in [STU-696](https://linear.app/studioag/issue/STU-696).

Tools are not validated at any level. An agent's `tools:` list and a contract's `required_tools:` are parsed as YAML and never cross-referenced against `tools/` or against the builtins.

Note on naming: contracts use dot format (`repo_manager.write_file`), the engine transforms to dash format (`repo_manager-write_file`) internally.

**Output format:**

```
Validating template at: /path/to/templates/software

✗ Structural validation failed

  metadata.json: missing required field 'description'
```

```
Validating template at: /path/to/templates/software

✓ Structural validation passed
✗ Semantic validation failed

  pipelines/feature-builder.pipeline.yaml: stage 'code-generation' references agent 'coder' which does not exist in agents/
```

---

## Testing requirements

**Stage 1 — Validate:**

```bash
studio template validate ./templates/<name>
```

Zero errors. Given the gap above, this proves `metadata.json` is well-formed; it does not prove the YAML is coherent.

**Stage 2 — Generation test:**

Generate into an empty directory — `studio init` refuses to run where a `.studio/` already exists, and has no flag to write elsewhere.

```bash
mkdir /tmp/studio-test && cd /tmp/studio-test
studio init test-project --template <name> --provider later
```

`--provider later` skips provider setup, so generation can be tested without a key or a local model.

Verifies placeholder substitution: an unresolved `{{...}}` aborts the command. Check the generated tree for leftover placeholders in filenames and in `.studio/` YAML, neither of which is substituted.

**Stage 3 — Pipeline smoke test:**

```bash
cd /tmp/studio-test
studio run <pipeline> --input-file .studio/inputs/<fixture>.input.yaml --provider mock
```

`--provider mock` replaces every LLM call, so this runs in CI without API keys. Use a real provider for manual testing.

> Ship at least one `inputs/*.input.yaml` fixture. It doubles as documentation and as test data.

---

## Versioning

Templates follow semantic versioning, declared in `metadata.json`:

```json
{ "name": "software", "version": "1.1.0" }
```

`studio init` and `studio registry install` record the installed version, type, timestamp and content hash in `.studio/registry.lock.json`.

Programmatic upgrades (`studio template update`) are not implemented. To pull updates today, copy revised pipeline and contract files from the template source by hand.
