# Template Authoring

Specification for authoring Studio templates and for the `studio validate template` CLI. This is contributor-facing. For a user-facing overview of available templates, see [TEMPLATES.md](../TEMPLATES.md).

---

## Required files

| Path | Status | Notes |
|------|--------|-------|
| `template.yaml` | Required | Template metadata, see format below |
| `README.md` | Required | User-facing documentation |
| `.studio/projects/{{TEMPLATE_NAME}}/pipelines/` | Required | ≥2 `.pipeline.yaml` files |
| `.studio/projects/{{TEMPLATE_NAME}}/contracts/` | Required | ≥1 `.contract.yaml` per pipeline |
| `.studio/projects/{{TEMPLATE_NAME}}/agents/` | Required | ≥1 `.agent.yaml` file |
| `.studio/projects/{{TEMPLATE_NAME}}/tools/` | Optional | Builtins are allowed |
| `.studio/projects/{{TEMPLATE_NAME}}/inputs/` | Required | ≥1 fixture input for smoke testing |
| `prisma/schema.prisma` | Required | Database schema starter |
| `src/index.ts` | Required | Entry point (`src/` must be non-empty) |
| `package.json` | Required | Node package definition |
| `tsconfig.json` | Optional | TypeScript config |

---

## `template.yaml` format

```yaml
name: software
version: 1.0.0
description: "Code generation and modification workflows"
category: software   # software | finance | analysis | data | conversation
min_studio_version: "1.0.0"
requires:
  pipelines: 2        # minimum pipeline count
  contracts: true     # contract count ≥ pipeline count
  agents: 1           # minimum agent count
  schema: true        # prisma/schema.prisma must exist
```

---

## Placeholder system

Placeholders use `{{DOUBLE_BRACES}}` syntax and are replaced during `studio init`.

**Built-in placeholders:**

| Placeholder | Value | Example |
|-------------|-------|---------|
| `{{PROJECT_NAME}}` | Name provided by user at `studio init` | `code-builder` |
| `{{TEMPLATE_NAME}}` | Source template name | `software` |
| `{{YEAR}}` | Current year at generation time | `2026` |

**Future placeholders** (set via `studio config set`, like `git config user.name`):

| Placeholder | Config key |
|-------------|------------|
| `{{AUTHOR}}` | `user.name` |
| `{{EMAIL}}` | `user.email` |
| `{{DESCRIPTION}}` | `user.description` |

**Where placeholders can appear:**
- Any file's contents
- Filenames: e.g. `{{PROJECT_NAME}}.config.ts`
- Directory names: e.g. `.studio/projects/{{TEMPLATE_NAME}}/`

**Error behavior:**
- Unresolved placeholder (config key not set) → generation fails, lists all missing placeholders.
- Unknown placeholder (not in the table above) → generation fails, does not silently skip.

---

## Validation rules

`studio validate template <path>` runs two levels in sequence and stops at first failure.

**Level 1: Structural** (fast, no parsing):
- `template.yaml` exists
- `README.md` exists
- `.studio/projects/` contains exactly one subdirectory
- Pipeline count ≥ `requires.pipelines`
- Contract count ≥ pipeline count
- Agent count ≥ `requires.agents`
- `prisma/schema.prisma` exists (when `requires.schema: true`)
- `src/` directory exists and is non-empty
- `inputs/` directory exists with at least one `.input.yaml` file

**Level 2: Semantic** (parse + cross-reference):
- All YAML files parse without errors
- Every pipeline stage references a contract that exists in `contracts/`
- Every pipeline stage references an agent that exists in `agents/`
- Every tool in an agent's `tools:` list exists in `tools/` or is a builtin
- Every tool in a contract's `required_tools:` exists in `tools/` or is a builtin
- No unknown placeholders appear in any file or filename

Builtins recognised by the validator: `repo_manager-read_file`, `repo_manager-write_file`, `repo_manager-list_files`, `shell-run_command`, `search-search_codebase`.

Note on naming: contracts use dot format (`repo_manager.write_file`), the engine transforms to dash format (`repo_manager-write_file`) internally. The validator reports errors in dash format.

**Output format:**

```
✓ Structural validation passed
✗ Semantic validation failed
  contracts/qa-review.contract.yaml: required_tool 'repo_manager-commit' not found
  agents/coder.agent.yaml: tool 'git-push' not found in tools/ or builtins
```

---

## Testing requirements

A template must pass all three stages before it can be merged.

**Stage 1 — Validate:**

```bash
studio validate template ./templates/<name>
```

Zero errors from structural + semantic validation.

**Stage 2 — Generation test:**

```bash
studio init --template <name> --name test-project --output /tmp/studio-test
studio validate template /tmp/studio-test
```

Verifies placeholder replacement produces a valid project: no unresolved `{{...}}`, all filenames valid, structure intact.

**Stage 3 — Pipeline smoke test:**

```bash
cd /tmp/studio-test
studio run <template-name>/first-pipeline \
  --input-file .studio/projects/<name>/inputs/example-1.input.yaml \
  --dry-run
```

At least one pipeline runs end-to-end against a fixture input. The `--dry-run` flag mocks all LLM calls. Use it in CI to avoid API costs. Use real API keys for manual testing.

> Every template **must** ship with at least one `inputs/*.input.yaml` fixture. This file doubles as documentation and as test data.

---

## Versioning

Templates follow semantic versioning:

```yaml
# templates/software/template.yaml
name: software
version: 1.2.0
```

When you generate a project from a template, the version is locked in `.studio/registry.lock.json`.

Programmatic upgrades (`studio template update`) are not yet implemented. To pull updates today, manually copy revised pipeline/contract files from the template source.
