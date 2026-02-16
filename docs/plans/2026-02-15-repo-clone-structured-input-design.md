# Design: Repo Clone + Structured Input

## Problem

The CLI currently accepts only a plain string via `--input` and uses CWD as the repo target. Real pipelines need:
1. Auto-cloning a git repo before execution
2. Structured input (target_page, acceptance_criteria, sample data, etc.)

## Decisions

- **Approach A (CLI-side):** Clone logic and input file parsing live in the CLI. The engine receives a local `repoPath` and structured input — it doesn't know about git URLs.
- **Clone naming:** `<pipeline>-<timestamp>` (e.g., `feature-builder-2026-02-15T19h30/`)
- **No auto-cleanup:** Users inspect results after runs.

## Pipeline YAML — new `repo` field

```yaml
name: feature-builder
version: 1

repo:
  url: https://github.com/arianeguay/pipelines-test-repo
  branch: main  # optional, defaults to repo's default branch

stages:
  # ... unchanged
```

## Input file format

```yaml
# inputs/faq-about.input.yaml
brief_summary: "Ajouter une section FAQ simple a la page About"
target_page: "src/pages/about.tsx"
acceptance_criteria:
  - "La section FAQ apparait sur la page About sans casser la mise en page."
  - "Chaque question est un accordeon."
sample_faq:
  - question: "C'est quoi ce projet?"
    answer: "Une breve description du site."
```

## CLI changes

```bash
# Input file (new)
studio run feature-builder --input-file ./inputs/faq.input.yaml

# Repo URL override (new)
studio run feature-builder --input-file ./inputs/faq.input.yaml --repo-url https://github.com/other/repo

# Plain string (unchanged, backwards-compatible)
studio run feature-builder --input "Add FAQ to About page"

# Local path (unchanged, skips clone)
studio run feature-builder --input-file ./inputs/faq.input.yaml --repo /tmp/my-repo
```

## Repo resolution priority

1. `--repo /path` — use local path directly, no clone
2. `--repo-url https://...` — clone to STUDIO_PROJECTS_DIR
3. `pipeline.repo.url` — clone to STUDIO_PROJECTS_DIR
4. None — use `.` (CWD)

## STUDIO_PROJECTS_DIR

Set via env variable or `.studiorc.yaml`:

```bash
STUDIO_PROJECTS_DIR=/home/arianeguay/dev/src/studio-projects
```

```yaml
# .studiorc.yaml
paths:
  projects_dir: ${STUDIO_PROJECTS_DIR}
```

If not set and a clone is required, error: `"STUDIO_PROJECTS_DIR is not set. Set it in .env or .studiorc.yaml paths.projects_dir"`.

## Clone flow

1. Parse pipeline YAML, find `repo.url`
2. Resolve STUDIO_PROJECTS_DIR
3. Create `$STUDIO_PROJECTS_DIR/<pipeline>-<timestamp>/`
4. `git clone --depth 1 [--branch <branch>] <url> <dir>`
5. Pass cloned dir as `repoPath` to engine
6. Execute pipeline normally
7. Print clone path at the end (for inspection)

## Files to modify

| File | Change |
|------|--------|
| `contracts/src/pipeline.ts` | Add `repo?: { url: string; branch?: string }` to `PipelineDefinition` |
| `cli/src/index.ts` | Add `--input-file`, `--repo-url` options |
| `cli/src/commands/run.ts` | Clone logic, input file reading, repo resolution |
| `cli/src/config.ts` | Add `paths.projects_dir` to `StudioConfig` |
| `engine/src/engine.ts` | `RunInput.input` accepts `string \| Record<string, unknown>` |
| `engine/src/pipeline/context-propagation.ts` | `PipelineContext.input` accepts `string \| Record<string, unknown>` |
| `engine/src/pipeline/loader.ts` | Parse new `repo` field from pipeline YAML |
| `runner/src/prompt-builder.ts` | Format structured input as readable YAML in prompt |
| `.env.example` | Add `STUDIO_PROJECTS_DIR` |
| `.studiorc.yaml` | Add `paths.projects_dir` |
