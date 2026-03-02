# STU-187 — Domain Invariants per Project: `.studio/invariants.md`

**Date:** 2026-03-01
**Status:** Approved
**Linear:** [STU-187](https://linear.app/studioag/issue/STU-187)

## Problem

Studio's kernel invariants are architectural, enforced by TypeScript package boundaries. There is no mechanism for a user project to declare its own domain invariants — rules that are specific to the project's domain, not the kernel.

Example from Wiki Creator: "output must never reproduce verbatim passages from the source book." This is a domain rule, not an architectural one, but it should be just as first-class.

## Solution

Support a `.studio/invariants.md` file in user project repos. When this file exists, its content is automatically injected into every agent's `system_prompt` at pipeline runtime. No per-agent or per-stage configuration required.

The file is intentionally free-form markdown — it is a governance document for humans and agents, not machine config. Enforcement stays in existing contracts and hooks.

## Architecture

### Approach

Load once at pipeline start, inject per-agent. Follows the same pattern as skill injection already in `engine/src/engine.ts`.

### Data Flow

```
pipeline run()
  ├── load startupContext (on_pipeline_start commands)
  ├── load invariantsContent (.studio/invariants.md — silent if missing)
  └── for each stage → executeStage(pipelineContext)
        ├── load agentConfig
        ├── inject plugin skills into system_prompt
        ├── inject project skills into system_prompt
        ├── inject invariants into system_prompt  ← NEW
        └── run RALPH loop
```

### Prompt Format

Invariants are appended after skills, before the user message:

```
<existing system_prompt>

<skills if any>

---

## Project Invariants

<contents of .studio/invariants.md>
```

## Files Changed

### Modified

- `engine/src/pipeline/context-propagation.ts` — add `invariantsContent?: string` to `PipelineContext`
- `engine/src/engine.ts`
  - In `run()`: load `.studio/invariants.md` into `pipelineContext.invariantsContent` after startup commands
  - In `executeStage()`: append to `agentConfig.system_prompt` after skill injection
- `CLAUDE.md` — document `.studio/invariants.md` pattern under Structure section

### New

- `engine/src/pipeline/invariants-loader.test.ts` — unit tests
- `templates/analysis/.studio/invariants.md` — Wiki Creator example

## Testing

- When `invariants.md` exists: content appears in `system_prompt` for every agent
- When `invariants.md` is missing: no error, `system_prompt` unchanged
- File is read once per pipeline run, not once per stage
