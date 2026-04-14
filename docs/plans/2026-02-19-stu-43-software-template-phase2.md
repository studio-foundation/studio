# STU-43 — Template software-full (Phase 2) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a `software-full` built-in template with the complete 4-stage pipeline (brief-analysis → implementation-plan → group[code-generation + qa-review]) that the Studio init wizard discovers automatically.

**Architecture:** Pure YAML/JSON data — no source code changes. The `listTemplates()` function in `cli/src/commands/templates.ts` already scans `cli/templates/projects/` dynamically, so adding a new subdirectory is enough for the wizard to discover it. TDD: update the templates test first to assert `software-full` exists, then create all files.

**Tech Stack:** YAML, JSON. Working dir: `/home/arianeguay/dev/src/Studio/`

**Design doc:** `docs/plans/2026-02-19-stu-43-software-template-phase2-design.md`

---

## Task 1 — Update templates test (TDD first)

**Files:**
- Modify: `cli/tests/commands/templates.test.ts`

The existing test `'returns all 4 built-in templates'` lists 4 templates. We must update it to 5 and add an assertion for `software-full`.

---

### Step 1.1 — Write the failing test update

In `cli/tests/commands/templates.test.ts`, replace:

```typescript
  it('returns all 4 built-in templates', async () => {
    const templates = await listTemplates();
    const names = templates.map((t) => t.name);
    expect(names).toContain('blank');
    expect(names).toContain('software');
    expect(names).toContain('content');
    expect(names).toContain('document-analysis');
  });
```

with:

```typescript
  it('returns all 5 built-in templates', async () => {
    const templates = await listTemplates();
    const names = templates.map((t) => t.name);
    expect(names).toContain('blank');
    expect(names).toContain('software');
    expect(names).toContain('software-full');
    expect(names).toContain('content');
    expect(names).toContain('document-analysis');
  });
```

---

### Step 1.2 — Run test to verify it fails

```bash
pnpm --filter @studio-foundation/cli test -- --reporter=verbose 2>&1 | grep -E "5 built-in|software-full|✓|✗|FAIL|PASS"
```

Expected: `✗ returns all 5 built-in templates` — fails because `software-full` doesn't exist yet.

---

## Task 2 — Create `software-full` template directory and metadata

**Files:**
- Create: `cli/templates/projects/software-full/metadata.json`

---

### Step 2.1 — Create directories

```bash
mkdir -p cli/templates/projects/software-full/project/{pipelines,agents,contracts,tools,inputs}
```

### Step 2.2 — Create `metadata.json`

`cli/templates/projects/software-full/metadata.json`:
```json
{
  "name": "software-full",
  "version": "1.0.0",
  "description": "Software development (full pipeline with QA review)",
  "author": "studio-core",
  "tags": ["software", "code", "development", "qa"],
  "type": "template",
  "studio_version": ">=7.0.0",
  "pipelines": ["feature-builder"],
  "tools_included": ["repo-manager", "search", "shell"]
}
```

### Step 2.3 — Run test to verify it passes

```bash
pnpm --filter @studio-foundation/cli test -- --reporter=verbose 2>&1 | grep -E "5 built-in|software-full|each template|sorted|✓|✗|FAIL|PASS"
```

Expected: all 3 template tests pass (the `'each template has name, version, description'` test and `'sorted alphabetically'` test also pass — `software-full` sorts after `software` which is correct).

---

## Task 3 — Create pipeline YAML

**Files:**
- Create: `cli/templates/projects/software-full/project/pipelines/feature-builder.pipeline.yaml`

Note: the engine's `parsePipelineYaml` (in `engine/src/pipeline/loader.ts`) requires each stage to have `name`, `kind`, and `agent`. Groups require at least 2 stages and have `group`, `max_iterations`, and `stages` fields.

Contract names in stage YAML are resolved by the engine as `<contract>.contract.yaml` in the project's contracts dir.

### Step 3.1 — Create pipeline file

`cli/templates/projects/software-full/project/pipelines/feature-builder.pipeline.yaml`:
```yaml
name: feature-builder
description: Analyze a request, plan the implementation, generate code, and QA review
version: 2

input_schema:
  type: structured
  fields:
    - name: brief_summary
      type: text
      required: true
      prompt: "Brief summary"
    - name: target_page
      type: text
      required: false
      prompt: "Target file or page (optional)"
    - name: acceptance_criteria
      type: array
      items: text
      prompt: "Acceptance criteria"

stages:
  - name: brief-analysis
    kind: analysis
    agent: analyst
    contract: brief-analysis
    ralph:
      max_attempts: 3
    context:
      include:
        - input

  - name: implementation-plan
    kind: planning
    agent: analyst
    contract: implementation-plan
    ralph:
      max_attempts: 3
    context:
      include:
        - input
        - previous_stage_output

  - group: implementation-review
    max_iterations: 3
    stages:
      - name: code-generation
        kind: code
        agent: coder
        contract: code-generation
        ralph:
          max_attempts: 3
        context:
          include:
            - input
            - all_stage_outputs
            - group_feedback

      - name: qa-review
        kind: qa
        agent: analyst
        contract: qa-review
        ralph:
          max_attempts: 3
        context:
          include:
            - input
            - all_stage_outputs
            - group_feedback
```

No test needed at this step — YAML validity is validated by the engine at runtime and by the loader unit tests which we'll run at the end.

---

## Task 4 — Create agents

**Files:**
- Create: `cli/templates/projects/software-full/project/agents/analyst.agent.yaml`
- Create: `cli/templates/projects/software-full/project/agents/coder.agent.yaml`

---

### Step 4.1 — Create `analyst.agent.yaml`

The analyst handles brief analysis, implementation planning, and QA review. It only needs search (no file writes).

`cli/templates/projects/software-full/project/agents/analyst.agent.yaml`:
```yaml
name: analyst
provider: anthropic
model: claude-sonnet-4-6
tools:
  - search-search_codebase
system_prompt: |
  You are a senior software analyst and QA engineer. You analyze feature requests
  thoroughly, create detailed implementation plans, and review code changes critically.
  When reviewing code, verify that all acceptance criteria are met and that the
  implementation is complete, correct, and follows good practices.
```

### Step 4.2 — Create `coder.agent.yaml`

Same as the `software` template — full tool access for reading, writing, and running commands.

`cli/templates/projects/software-full/project/agents/coder.agent.yaml`:
```yaml
name: coder
provider: anthropic
model: claude-sonnet-4-6
tools:
  - repo_manager-read_file
  - repo_manager-write_file
  - repo_manager-list_files
  - shell-run_command
  - search-search_codebase
system_prompt: |
  You are an expert software developer. Analyze the request and implement
  the changes using the available tools. Read relevant files first,
  then write clean, working code.
```

---

## Task 5 — Create contracts

**Files:**
- Create: `cli/templates/projects/software-full/project/contracts/brief-analysis.contract.yaml`
- Create: `cli/templates/projects/software-full/project/contracts/implementation-plan.contract.yaml`
- Create: `cli/templates/projects/software-full/project/contracts/code-generation.contract.yaml`
- Create: `cli/templates/projects/software-full/project/contracts/qa-review.contract.yaml`

Note: `required_tools` in contracts use dot format (`repo_manager.write_file`) — the engine transforms this to the dash format used by the runner.

---

### Step 5.1 — Create `brief-analysis.contract.yaml`

`cli/templates/projects/software-full/project/contracts/brief-analysis.contract.yaml`:
```yaml
name: brief-analysis
version: 1
schema:
  required_fields:
    - summary
    - requirements
    - acceptance_criteria
```

### Step 5.2 — Create `implementation-plan.contract.yaml`

`cli/templates/projects/software-full/project/contracts/implementation-plan.contract.yaml`:
```yaml
name: implementation-plan
version: 1
schema:
  required_fields:
    - summary
    - implementation_steps
    - files_to_modify
```

### Step 5.3 — Create `code-generation.contract.yaml`

Anti-theatre: requires at least 1 tool call and specifically requires `repo_manager.write_file` to have been called (agent must actually write files, not just describe changes).

`cli/templates/projects/software-full/project/contracts/code-generation.contract.yaml`:
```yaml
name: code-generation
version: 1
schema:
  required_fields:
    - summary
    - files_changed
tool_calls:
  minimum: 1
  required_tools:
    - repo_manager.write_file
```

### Step 5.4 — Create `qa-review.contract.yaml`

Rejection detection on `status`: if status is `rejected` or `needs_revision`, the group iterates again with the QA feedback injected into `group_feedback`.

`cli/templates/projects/software-full/project/contracts/qa-review.contract.yaml`:
```yaml
name: qa-review
version: 1
schema:
  required_fields:
    - status
    - summary
    - issues
post_validation:
  rejection_detection:
    field: status
    approved_values:
      - approved
      - approved_with_notes
    rejected_values:
      - rejected
      - needs_revision
    details_field: issues
    summary_field: summary
```

---

## Task 6 — Copy tool files and create example input

**Files:**
- Create: `cli/templates/projects/software-full/project/tools/repo-manager.tool.yaml`
- Create: `cli/templates/projects/software-full/project/tools/search.tool.yaml`
- Create: `cli/templates/projects/software-full/project/tools/shell.tool.yaml`
- Create: `cli/templates/projects/software-full/project/inputs/example.input.yaml`

---

### Step 6.1 — Copy tool files from `software` template

```bash
cp cli/templates/projects/software/project/tools/repo-manager.tool.yaml cli/templates/projects/software-full/project/tools/
cp cli/templates/projects/software/project/tools/search.tool.yaml cli/templates/projects/software-full/project/tools/
cp cli/templates/projects/software/project/tools/shell.tool.yaml cli/templates/projects/software-full/project/tools/
```

### Step 6.2 — Create `example.input.yaml`

`cli/templates/projects/software-full/project/inputs/example.input.yaml`:
```yaml
brief_summary: "Add a hello world function to src/utils.ts"
target_page: "src/utils.ts"
acceptance_criteria:
  - "Function is exported and returns 'Hello, World!'"
  - "Function has TypeScript type annotations"
```

---

## Task 7 — Full test run + verification

### Step 7.1 — Run all tests

```bash
pnpm test
```

Expected: all tests pass. No regressions.

### Step 7.2 — Verify template structure is complete

```bash
find cli/templates/projects/software-full -type f | sort
```

Expected output (12 files):
```
cli/templates/projects/software-full/metadata.json
cli/templates/projects/software-full/project/agents/analyst.agent.yaml
cli/templates/projects/software-full/project/agents/coder.agent.yaml
cli/templates/projects/software-full/project/contracts/brief-analysis.contract.yaml
cli/templates/projects/software-full/project/contracts/code-generation.contract.yaml
cli/templates/projects/software-full/project/contracts/implementation-plan.contract.yaml
cli/templates/projects/software-full/project/contracts/qa-review.contract.yaml
cli/templates/projects/software-full/project/inputs/example.input.yaml
cli/templates/projects/software-full/project/pipelines/feature-builder.pipeline.yaml
cli/templates/projects/software-full/project/tools/repo-manager.tool.yaml
cli/templates/projects/software-full/project/tools/search.tool.yaml
cli/templates/projects/software-full/project/tools/shell.tool.yaml
```

### Step 7.3 — Verify wizard shows the new template

```bash
node cli/dist/index.js templates list
```

Expected output includes:
```
  software-full  Software development (full pipeline with QA review)
```

### Step 7.4 — Build

```bash
pnpm build
```

Expected: clean build, no TypeScript errors.

---

## Task 8 — Commit

### Step 8.1 — Commit

```bash
git add cli/templates/projects/software-full/ cli/tests/commands/templates.test.ts
git commit -m "feat(cli): STU-43 — add software-full template with full 4-stage pipeline"
```

---

## Acceptance Criteria Check

| Criterion | Covered by |
|---|---|
| Template `software-full/` created | Tasks 2–6 |
| Pipeline with 4 stages (brief → plan → group[code + qa]) | Task 3 |
| 2 agents: analyst + coder | Task 4 |
| 4 contracts: brief-analysis, implementation-plan, code-generation, qa-review | Task 5 |
| `qa-review.contract.yaml` has `post_validation.rejection_detection` | Task 5.4 |
| `code-generation.contract.yaml` has anti-theatre (`tool_calls.minimum: 1`) | Task 5.3 |
| Group `implementation-review` with `max_iterations: 3` | Task 3 |
| Tools: repo_manager, search, shell | Task 6.1 |
| Example input file | Task 6.2 |
| `metadata.json` with clear description | Task 2.2 |
| Wizard lists "Software development (full pipeline with QA review)" | Task 7.3 |
