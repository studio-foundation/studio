# Template System Architecture Design
**Issue:** STU-69
**Date:** 2026-02-19
**Status:** Approved

## Summary

Formal specification for the Studio template system, covering directory structure, `template.yaml` format, placeholder replacement strategy, validation rules, and testing requirements. This spec guides STU-70 (template validation CLI implementation).

---

## 1. Directory Structure

```
templates/<template-name>/
├── template.yaml                           # REQUIRED: metadata
├── README.md                               # REQUIRED: documentation
├── .studio/
│   └── projects/{{TEMPLATE_NAME}}/         # dir name uses placeholder
│       ├── pipelines/                      # REQUIRED: ≥2 files
│       │   └── *.pipeline.yaml
│       ├── contracts/                      # REQUIRED: ≥1 per pipeline
│       │   └── *.contract.yaml
│       ├── agents/                         # REQUIRED: ≥1 file
│       │   └── *.agent.yaml
│       ├── tools/                          # OPTIONAL (builtins allowed)
│       │   └── *.tool.yaml
│       └── inputs/                         # OPTIONAL but recommended
│           └── *.input.yaml
├── prisma/
│   └── schema.prisma                       # REQUIRED
├── src/
│   └── index.ts                            # REQUIRED (entry point)
├── package.json                            # REQUIRED
└── tsconfig.json                           # OPTIONAL
```

---

## 2. `template.yaml` Format

```yaml
name: software
version: 1.0.0
description: "Code generation and modification workflows"
category: software   # software | finance | analysis | data | conversation
min_studio_version: "1.0.0"
requires:
  pipelines: 2        # minimum count
  contracts: true     # ≥1 per pipeline
  agents: 1           # minimum count
  schema: true        # prisma/schema.prisma must exist
```

---

## 3. Placeholder System

### Built-in Placeholders

| Placeholder | Value | Example |
|---|---|---|
| `{{PROJECT_NAME}}` | Name provided by user at `studio init` | `code-builder` |
| `{{TEMPLATE_NAME}}` | Source template name | `software` |
| `{{YEAR}}` | Current year | `2026` |

### Future Placeholders (via `studio config set`)

Extensible like `git config user.name`. Additional placeholders become available when the corresponding config key is set:

| Placeholder | Config key |
|---|---|
| `{{AUTHOR}}` | `user.name` |
| `{{EMAIL}}` | `user.email` |
| `{{DESCRIPTION}}` | `user.description` |

### Where Placeholders Can Appear

- File contents (any file in the template)
- Filenames — e.g., `{{PROJECT_NAME}}.config.ts`
- Directory names — e.g., `.studio/projects/{{TEMPLATE_NAME}}/`

### Behavior

- **Unresolved placeholder** (e.g., `{{AUTHOR}}` when `user.name` not set) → generation fails with a clear error listing all missing placeholders
- **Unknown placeholder** (e.g., `{{TYPO}}`) → same: fail with error, never silently skip

---

## 4. Validation Rules

`studio validate template <path>` runs two levels in sequence. Stops at first failure.

### Level 1 — Structural (fast, no parsing)

- `template.yaml` exists
- `README.md` exists
- `.studio/projects/` contains exactly one subdirectory
- Pipeline count ≥ `requires.pipelines`
- Contract count ≥ pipeline count (at least one per pipeline)
- Agent count ≥ `requires.agents`
- `prisma/schema.prisma` exists (if `requires.schema: true`)
- `src/` exists and is non-empty

### Level 2 — Semantic (parse + cross-reference)

- All YAML files parse without errors
- Every pipeline stage references a contract that exists in `contracts/`
- Every pipeline stage references an agent that exists in `agents/`
- Every tool listed in an agent's `tools:` array exists in `tools/` or is a builtin
- Every tool listed in a contract's `required_tools:` exists in `tools/` or is a builtin
- No unknown placeholders (`{{...}}`) appear in any file or filename

### Output Format

```
✓ Structural validation passed
✗ Semantic validation failed
  contracts/qa-review.contract.yaml: required_tool 'repo_manager-commit' not found
  agents/coder.agent.yaml: tool 'git-push' not found in tools/ or builtins
```

---

## 5. Testing Requirements

A template must pass 3 levels before it can be merged.

### Level 1 — Validate (in template source dir)

```bash
studio validate template ./templates/<name>
```

Structural + semantic validation passes with zero errors.

### Level 2 — Generation Test (in temp dir)

```bash
studio init --template <name> --name test-project --output /tmp/studio-test
studio validate template /tmp/studio-test
```

Verifies placeholder replacement produces a valid project: no unresolved `{{...}}`, all filenames valid, structure intact.

### Level 3 — Pipeline Smoke Test (against fixture inputs)

```bash
cd /tmp/studio-test
studio run <template-name>/first-pipeline \
  --input-file .studio/projects/<name>/inputs/example-1.input.yaml \
  --dry-run
```

At least one pipeline runs end-to-end against a fixture input. Uses `--dry-run` in CI (LLM calls mocked), real API in manual testing.

**Implication:** every template must ship with at least one `inputs/*.input.yaml` fixture. This doubles as documentation and test data.

---

## Decisions Made

| Decision | Choice | Rationale |
|---|---|---|
| Placeholder location | Contents + filenames + dirs | Needed to rename `.studio/projects/{{TEMPLATE_NAME}}/` |
| Placeholder set | PROJECT_NAME, TEMPLATE_NAME, YEAR | Minimal viable set; extensible via config |
| Placeholder extensibility | `studio config set user.name` style | Consistent with git mental model |
| `template.yaml` | Identity + constraints + manifest (`requires` block) | Self-describing; enables CLI validation without hardcoding |
| Validation depth | Structural + semantic (no generation dry-run) | Catches 95% of issues; dry-run complexity deferred |
| Testing | Lint + generation + pipeline smoke test | Gold standard; `--dry-run` makes CI practical |
