# STU-43 — Template software-full (Phase 2) Design

## Goal

Create a `software-full` built-in template that ships a complete 4-stage pipeline with brief analysis, implementation planning, code generation, and QA review (with feedback loop). This is Phase 2 of STU-33 — the `software` template stays untouched.

## Decision

**New separate template** (`software-full/`) rather than modifying the existing `software/` template. Users can choose the complexity level at `studio init` time.

**Zero code changes** — the template loader and init wizard already discover templates dynamically from `cli/templates/projects/`. Adding the directory is sufficient.

## Directory Structure

```
cli/templates/projects/software-full/
├── metadata.json
└── project/
    ├── pipelines/
    │   └── feature-builder.pipeline.yaml
    ├── agents/
    │   ├── analyst.agent.yaml
    │   └── coder.agent.yaml
    ├── contracts/
    │   ├── brief-analysis.contract.yaml
    │   ├── implementation-plan.contract.yaml
    │   ├── code-generation.contract.yaml
    │   └── qa-review.contract.yaml
    ├── tools/
    │   ├── repo-manager.tool.yaml
    │   ├── search.tool.yaml
    │   └── shell.tool.yaml
    └── inputs/
        └── example.input.yaml
```

## Pipeline Design

### `feature-builder.pipeline.yaml`

4 stages: 2 linear then 1 group of 2 with `max_iterations: 3`.

```
brief-analysis        (analyst, contract: brief-analysis)
       ↓
implementation-plan   (analyst, contract: implementation-plan)
       ↓
group: implementation-review (max_iterations: 3)
       ├── code-generation   (coder, contract: code-generation)
       └── qa-review         (analyst, contract: qa-review)
```

**Context propagation:**

| Stage | Context |
|---|---|
| brief-analysis | `input` |
| implementation-plan | `input`, `previous_stage_output` |
| code-generation | `input`, `all_stage_outputs`, `group_feedback` |
| qa-review | `input`, `all_stage_outputs`, `group_feedback` |

**Group feedback loop:** If `qa-review` rejects (status ∈ rejected values), the group restarts from `code-generation` with accumulated `group_feedback` from previous QA rejections. Max 3 iterations.

## Agents

### `analyst.agent.yaml`
- Provider: anthropic, model: claude-sonnet-4-6
- Tools: `search-search_codebase` only
- Role: brief analysis, implementation planning, QA review

### `coder.agent.yaml`
- Provider: anthropic, model: claude-sonnet-4-6
- Tools: `repo_manager-read_file`, `repo_manager-write_file`, `repo_manager-list_files`, `shell-run_command`, `search-search_codebase`
- Role: code implementation

## Contracts

### `brief-analysis.contract.yaml`
Required fields: `summary`, `requirements`, `acceptance_criteria`

### `implementation-plan.contract.yaml`
Required fields: `summary`, `implementation_steps`, `files_to_modify`

### `code-generation.contract.yaml`
Required fields: `summary`, `files_changed`
Anti-theatre: `tool_calls.minimum: 1`, `required_tools: [repo_manager.write_file]`

### `qa-review.contract.yaml`
Required fields: `status`, `summary`, `issues`
Post-validation rejection detection:
- `field: status`
- `approved_values: [approved, approved_with_notes]`
- `rejected_values: [rejected, needs_revision]`
- `details_field: issues`
- `summary_field: summary`

## metadata.json

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

The init wizard will display: `software-full — Software development (full pipeline with QA review)`

## Files Changed

| File | Action |
|---|---|
| `cli/templates/projects/software-full/metadata.json` | Create |
| `cli/templates/projects/software-full/project/pipelines/feature-builder.pipeline.yaml` | Create |
| `cli/templates/projects/software-full/project/agents/analyst.agent.yaml` | Create |
| `cli/templates/projects/software-full/project/agents/coder.agent.yaml` | Create |
| `cli/templates/projects/software-full/project/contracts/brief-analysis.contract.yaml` | Create |
| `cli/templates/projects/software-full/project/contracts/implementation-plan.contract.yaml` | Create |
| `cli/templates/projects/software-full/project/contracts/code-generation.contract.yaml` | Create |
| `cli/templates/projects/software-full/project/contracts/qa-review.contract.yaml` | Create |
| `cli/templates/projects/software-full/project/tools/repo-manager.tool.yaml` | Create (copy) |
| `cli/templates/projects/software-full/project/tools/search.tool.yaml` | Create (copy) |
| `cli/templates/projects/software-full/project/tools/shell.tool.yaml` | Create (copy) |
| `cli/templates/projects/software-full/project/inputs/example.input.yaml` | Create |

No code changes required.

## Acceptance Criteria

- [ ] Template `software-full/` created with complete structure
- [ ] Pipeline `feature-builder` has 4 stages (brief → plan → group[code + qa])
- [ ] 2 agents: `analyst.agent.yaml`, `coder.agent.yaml`
- [ ] 4 contracts: brief-analysis, implementation-plan, code-generation, qa-review
- [ ] `qa-review.contract.yaml` has `post_validation.rejection_detection` configured
- [ ] `code-generation.contract.yaml` has anti-theatre (`tool_calls.minimum: 1`)
- [ ] Group `implementation-review` with `max_iterations: 3`
- [ ] Tools: repo_manager, search, shell
- [ ] Example input file present
- [ ] `metadata.json` with clear description
- [ ] Wizard `studio init` lists "Software development (full pipeline with QA review)" as option
