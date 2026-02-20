# Template System Architecture Spec Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a formal "Template Specification" section to TEMPLATES.md covering directory structure, `template.yaml` format, placeholder strategy, validation rules, and testing requirements.

**Architecture:** Documentation-only edit. Insert a new `## Template Specification` section into TEMPLATES.md between the existing "Template Structure" and "Using Templates" sections. Simplify the "Creating Custom Templates > Structure requirements" subsection to reference the new spec instead of duplicating content.

**Tech Stack:** Markdown only. No code.

---

### Task 1: Insert the Template Specification section

**Files:**
- Modify: `TEMPLATES.md` (between line ~387 and ~389 — after the Template Structure closing ` ``` ` block, before `## Using Templates`)

**Step 1: Read the current file around the insertion point**

Read `TEMPLATES.md` lines 354–395 to confirm exact boundaries of the "Template Structure" section and find the precise insertion point.

**Step 2: Insert the new section**

Insert the following block immediately after the closing `tsconfig.json` line of the template structure tree (line ~387), and before the `## Using Templates` heading:

````markdown

---

## Template Specification

This section is the **formal contract** for template authors and for the validation CLI (STU-70). User-facing documentation is in the sections above.

### Required Files

| Path | Required | Notes |
|------|----------|-------|
| `template.yaml` | Yes | Template metadata — see format below |
| `README.md` | Yes | User-facing documentation |
| `.studio/projects/{{TEMPLATE_NAME}}/pipelines/` | Yes | ≥2 `.pipeline.yaml` files |
| `.studio/projects/{{TEMPLATE_NAME}}/contracts/` | Yes | ≥1 `.contract.yaml` per pipeline |
| `.studio/projects/{{TEMPLATE_NAME}}/agents/` | Yes | ≥1 `.agent.yaml` file |
| `.studio/projects/{{TEMPLATE_NAME}}/tools/` | No | Optional — builtins are allowed |
| `.studio/projects/{{TEMPLATE_NAME}}/inputs/` | No | Recommended — fixture inputs for testing |
| `prisma/schema.prisma` | Yes | Database schema starter |
| `src/index.ts` | Yes | Entry point — `src/` must be non-empty |
| `package.json` | Yes | Node package definition |
| `tsconfig.json` | No | TypeScript config |

### `template.yaml` Format

```yaml
name: software
version: 1.0.0
description: "Code generation and modification workflows"
category: software   # software | finance | analysis | data | conversation
min_studio_version: "1.0.0"
requires:
  pipelines: 2        # minimum pipeline count
  contracts: true     # ≥1 contract per pipeline
  agents: 1           # minimum agent count
  schema: true        # prisma/schema.prisma must exist
```

### Placeholder System

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
- Filenames — e.g., `{{PROJECT_NAME}}.config.ts`
- Directory names — e.g., `.studio/projects/{{TEMPLATE_NAME}}/`

**Error behavior:**
- Unresolved placeholder (config key not set) → generation fails, lists all missing placeholders
- Unknown placeholder (not in the table above) → generation fails, does not silently skip

### Validation Rules

`studio validate template <path>` runs two levels in sequence and stops at first failure.

**Level 1 — Structural** (fast, no parsing):
- `template.yaml` exists
- `README.md` exists
- `.studio/projects/` contains exactly one subdirectory
- Pipeline count ≥ `requires.pipelines`
- Contract count ≥ pipeline count
- Agent count ≥ `requires.agents`
- `prisma/schema.prisma` exists (when `requires.schema: true`)
- `src/` directory exists and is non-empty

**Level 2 — Semantic** (parse + cross-reference):
- All YAML files parse without errors
- Every pipeline stage references a contract that exists in `contracts/`
- Every pipeline stage references an agent that exists in `agents/`
- Every tool in an agent's `tools:` list exists in `tools/` or is a builtin
- Every tool in a contract's `required_tools:` exists in `tools/` or is a builtin
- No unknown placeholders appear in any file or filename

**Output format:**
```
✓ Structural validation passed
✗ Semantic validation failed
  contracts/qa-review.contract.yaml: required_tool 'repo_manager-commit' not found
  agents/coder.agent.yaml: tool 'git-push' not found in tools/ or builtins
```

### Testing Requirements

A template must pass all three levels before it can be merged.

**Level 1 — Validate:**
```bash
studio validate template ./templates/<name>
```
Zero errors from structural + semantic validation.

**Level 2 — Generation test:**
```bash
studio init --template <name> --name test-project --output /tmp/studio-test
studio validate template /tmp/studio-test
```
Verifies placeholder replacement produces a valid project — no unresolved `{{...}}`, all filenames valid, structure intact.

**Level 3 — Pipeline smoke test:**
```bash
cd /tmp/studio-test
studio run <template-name>/first-pipeline \
  --input-file .studio/projects/<name>/inputs/example-1.input.yaml \
  --dry-run
```
At least one pipeline runs end-to-end against a fixture input. Uses `--dry-run` in CI (LLM calls mocked). Real API in manual testing.

> Every template **must** ship with at least one `inputs/*.input.yaml` fixture. This file doubles as documentation and as test data.

---
````

**Step 3: Verify the insertion looks correct**

Read `TEMPLATES.md` lines 354–430 to confirm:
- The new section appears between "Template Structure" and "Using Templates"
- No heading levels are broken
- The `---` horizontal rule separates it cleanly

**Step 4: Commit**

```bash
git add TEMPLATES.md
git commit -m "docs(templates): add formal Template Specification section (STU-69)"
```

---

### Task 2: Simplify the "Creating Custom Templates > Structure requirements" subsection

**Files:**
- Modify: `TEMPLATES.md` lines ~444–455 (the "Structure requirements" subsection under "Creating Custom Templates")

**Step 1: Read the current subsection**

Read `TEMPLATES.md` lines 433–475 to see the current "Structure requirements" content exactly.

**Step 2: Replace with a reference to the formal spec**

Replace the existing numbered list under "### Structure requirements" with a short redirect:

```markdown
### Structure requirements

A valid template must satisfy all rules defined in the [Template Specification](#template-specification) section above.

Run `studio validate template <path>` to check your template against the full ruleset.
```

**Step 3: Verify**

Read the surrounding context to confirm the subsection reads cleanly and the anchor link target (`## Template Specification`) exists.

**Step 4: Commit**

```bash
git add TEMPLATES.md
git commit -m "docs(templates): simplify custom template structure requirements to reference spec (STU-69)"
```

---

### Task 3: Final review

**Step 1: Read the full TEMPLATES.md**

Read the entire file to confirm:
- No duplicated content between old and new sections
- All heading levels are consistent (h2 for major sections, h3 for subsections)
- The new spec section flows naturally between "Template Structure" and "Using Templates"
- The "Creating Custom Templates" section still makes sense with the simplified "Structure requirements"

**Step 2: Mark STU-69 complete in Linear**

Update the Linear issue STU-69 to Done.
