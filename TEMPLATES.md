# Templates

A template is a starting point for a project: pipelines, contracts, and — for some of
them — an app scaffold (`src/`, `prisma/`, `package.json`). It is not a finished product;
it is a structure you customize.

Templates are **registry packages**, not files carried by the kernel. The only exception is
`blank`, which is bundled because it has nothing to fetch.

---

## Available templates

`studio templates list` prints the live list. As of Studio 0.13.0 the official marketplace
publishes five, plus the bundled `blank`:

| Template | Ships | Required plugins |
|----------|-------|------------------|
| `blank` | Empty `.studio/` subdirectories | — (bundled, no install) |
| `software` | 3 pipelines, 2 contracts, `src/`, `prisma/`, `package.json`, `README.md` | `repo-manager`, `shell`, `search`, `coder`, `git` |
| `software-full` | 1 pipeline (5 stages incl. a QA group), 5 contracts | `repo-manager`, `shell`, `search`, `git`, `coder`, `analyst`, `publisher`, `reviewer` (recommended: `code-conventions`, `git-workflow`) |
| `content` | 1 pipeline, 1 contract, `src/`, `prisma/`, `package.json`, `README.md` | `search`, `writer` |
| `document-analysis` | 1 pipeline, 1 contract | `search`, `analyst` |
| `parallel-tasks` | 1 pipeline (fan-out group of 5 + consolidation), 3 contracts | `planner`, `worker`, `consolidator` |

No template ships its own agents or tools — every agent and tool comes from the plugins
listed above, installed as dependencies. See
[CONCEPTS.md](CONCEPTS.md#package-dependencies) for the dependency format.

---

## What `studio init --template <name>` does

1. **Installs the template from the registry** into `.studio/projects/<name>/`, together
   with the plugins it declares as dependencies. Required plugins install unconditionally;
   recommended ones are prompted in the wizard and skipped otherwise. An unresolved
   required dependency aborts init rather than producing a project that cannot run.
2. Copies `pipelines/`, `contracts/`, `agents/`, `tools/`, `inputs/` from there into
   `.studio/`, creating any the template omits as empty directories.
3. Copies the app scaffold — `src/`, `prisma/`, `package.json`, `README.md` — to the
   project root, substituting `{{PROJECT_NAME}}`, `{{TEMPLATE_NAME}}` and `{{YEAR}}`.
   Templates without those files skip this step.
4. Writes `.studio/config.yaml` (gitignored) and `.studio/config.example.yaml`.
5. Writes `ONBOARDING.md` at the project root, never overwriting an existing one.
6. Runs `git init` unless the directory is already a repo.

**Network:** step 1 fetches over HTTP. When the network is unreachable, the default
marketplace falls back to the seed — a snapshot of that marketplace bundled with the CLI —
so every template and plugin listed above still installs offline. A marketplace you
registered yourself has no seed and needs connectivity.

```bash
mkdir code-builder && cd code-builder
studio init code-builder --template software --provider later
npm install
studio config set provider anthropic --api-key $ANTHROPIC_API_KEY
studio doctor
studio run feature-builder --input "Add dark mode support"
```

`studio init` refuses to run where a `.studio/` already exists and has no flag to write
elsewhere — start from an empty directory.

---

## The templates in detail

### `software` — code generation

**Pipelines:** `feature-builder` (structured input; one `code-generation` stage gated by
`tsc --noEmit` and `eslint` hooks that reject on failure), `quick-edit` (single-file edit,
contract `quick-edit-output`, `tool_calls.minimum: 1`), `quick-fix` (targeted fix).

**Scaffold:** `src/index.ts`, `prisma/schema.prisma`, `package.json`, `README.md`.

### `software-full` — code generation with QA review

**Pipeline:** `feature-builder` — `brief-analysis` → `implementation-plan` →
group `implementation-review` (`code-generation` ↔ `qa-review`, bounded by
`max_iterations`) → `publish-changes`.

The template that exercises the most kernel surface: anti-theatre (`code-generation`
requires a write or patch call, `publish-changes` requires `git-checkout` + `git-commit`),
rejection detection on `qa-review`, and a group feedback loop.

**Scaffold:** none — `.studio/` configs only.

### `content` — research and content creation

**Pipeline:** `content-creator` — one `content-generation` stage on the `writer` agent.

**Scaffold:** `src/index.ts`, `prisma/schema.prisma`, `package.json`, `README.md`.

### `document-analysis` — extraction and structured analysis

**Pipeline:** `analyzer` — one `analysis` stage on the `analyst` agent.

**Scaffold:** none.

### `parallel-tasks` — fan-out execution

**Pipeline:** `parallel-tasks` — `task-selection` (its contract requires exactly 5 tasks) →
group `task-execution` (`task-1`…`task-5`, all on the `worker` agent) → `consolidation`.

**Scaffold:** none.

> **Known gap.** In `software`, `content` and `document-analysis`, some stages declare no
> `contract:`, so contract files those templates ship are never applied. `contract` is
> optional in a pipeline and an absent one means no validation at all — wire it yourself if
> you want the guarantee. `software-full` and `parallel-tasks` reference a contract on
> every stage.

---

## Customization workflow

1. **Run the defaults** with `--provider mock` first, to see the shape without spending tokens.
2. **Extend the pipelines** — add stages, or add a `contract:` where one is missing.
3. **Add tools** — `studio registry install <plugin>`, or write your own `.tool.yaml`.
4. **Extend the schema** if the template shipped a `prisma/`.

Once generated, the files are yours.

---

## Frequently asked questions

### Do I need a template?

No. `studio init --template blank` gives you the directory structure and nothing else, and
you can also create `.studio/` by hand.

### Can I combine two templates?

Not in one command. Generate from the closest one, then copy the pipelines and contracts
you want out of another — they are plain YAML files.

### Can a generated project be upgraded to a newer template version?

Not programmatically; `studio template update` does not exist. `studio registry update`
updates installed *plugins*, not the files a template copied into `.studio/`. Copy revised
pipeline and contract files by hand, after committing.

---

## Authoring your own

The full specification — layout, `metadata.json` format, placeholders, validation rules,
testing workflow — is in [docs/TEMPLATE_AUTHORING.md](./docs/TEMPLATE_AUTHORING.md).

```bash
studio template validate <path>
```

To publish, submit the template to
[studio-community](https://github.com/studio-foundation/studio-community) or run
`studio registry publish <path>`. Once merged, anyone installs it with
`studio init --template <name>`.

---

**See also:**
- [README.md](./README.md): public-facing overview
- [CLI.md](./CLI.md): `studio init`, `studio templates`, `studio registry` reference
- [docs/TEMPLATE_AUTHORING.md](./docs/TEMPLATE_AUTHORING.md): specification for template authors
- [docs/adr/0002-packaging-model.md](./docs/adr/0002-packaging-model.md): why `template` and `plugin` are the only two package types
