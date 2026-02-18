# Context Packs Design — STU-13

**Date:** 2026-02-17
**Issue:** [STU-13 — Rich context packs (conventions, standards, docs)](https://linear.app/studioag/issue/STU-13)
**Status:** Approved

---

## Problem

Agents need access to project-specific conventions, standards, and documentation (style guides, architecture patterns, testing standards) to produce output that fits the target codebase. Currently, this must be hardcoded in agent system prompts or manually included in pipeline inputs — neither scales across projects.

---

## Approach

**Engine resolves packs → new `context_packs` field in AgentContext → runner formats into prompt sections.**

The engine loads and resolves pack YAML files (reading workspace files, assembling inline content). The resolved content is passed through `AgentContext` to the runner. The runner formats each pack as a distinct titled section in the LLM prompt.

Chosen over alternatives:
- Folding into `additional_context` string (loses structure, harder to test)
- Runner-side loading (breaks architecture: runner has no access to config paths)

---

## Architecture

### Pack YAML format

Lives at `engine/configs/<project>/context-packs/<name>.yaml`:

```yaml
name: React Conventions
description: React/TypeScript coding standards
version: 1

files:                          # Read from external workspace at runtime
  - path: docs/STYLE_GUIDE.md
  - path: docs/COMPONENT_PATTERNS.md

inline:                         # Injected directly from YAML
  - title: "Naming conventions"
    content: |
      - Components: PascalCase
      - Functions: camelCase
      - Constants: UPPER_SNAKE_CASE

  - title: "Error handling"
    content: |
      Always use try-catch for async operations.
      Log errors with context.
```

### Pipeline usage

```yaml
stages:
  - name: code-generation
    agent: coder
    context:
      include: [input, all_stage_outputs, group_feedback]
      packs: [react-conventions, testing-standards]
```

---

## Types (contracts)

New file `contracts/src/context-pack.ts`:

```typescript
export interface ContextPackDefinition {
  name: string;
  description?: string;
  version: number;
  files?: Array<{ path: string }>;
  inline?: Array<{ title: string; content: string }>;
}

export interface ResolvedContextPack {
  name: string;
  description?: string;
  sections: Array<{ title: string; content: string }>;
}
```

Extensions to existing types:

```typescript
// contracts/src/pipeline.ts — StageDefinition
context?: {
  include: string[];
  packs?: string[];
};

// runner/src/prompt-builder.ts — AgentContext
context_packs?: ResolvedContextPack[];
```

---

## Engine — Pack Loading

New file: `engine/src/pipeline/context-pack-loader.ts`

```typescript
export async function loadContextPacks(
  packNames: string[],
  projectConfigPath: string,  // engine/configs/<project>/
  workspacePath?: string,     // external project repo (for files[])
): Promise<ResolvedContextPack[]>
```

Resolution logic per pack:

1. Resolve path: `<projectConfigPath>/context-packs/<name>.yaml`
2. **Hard error** if pack file does not exist
3. For each `files[]` entry: read `<workspacePath>/<path>` — **hard error** if file missing
4. File sections: title = file path, content = raw file content
5. Inline sections: title and content from YAML directly
6. Sections order: files first (in order), then inline (in order)

Called from `engine/src/engine.ts` after `getContextForStage()`:

```typescript
const agentContext = getContextForStage(pipelineContext, stageDef, previousStageName);

if (stageDef.context?.packs?.length) {
  agentContext.context_packs = await loadContextPacks(
    stageDef.context.packs,
    this.projectConfigPath,
    pipelineContext.repoPath,
  );
}
```

`getContextForStage()` remains synchronous. `pipelineContext.repoPath` already carries the external workspace path.

---

## Runner — Prompt Formatting

In `runner/src/prompt-builder.ts`, packs are injected after `## Additional Context` and before `## Task`:

```
## React Conventions — React/TypeScript coding standards

### docs/STYLE_GUIDE.md

<file contents>

### Naming conventions

- Components: PascalCase
...

## Testing Standards

### ...
```

Each pack → `##` section. Each section (file or inline) → `###` subsection.

---

## Cleanup

`runner/src/context/context-pack.ts` — **delete**. Its repo-structure logic is superseded by the engine-side loader. Update `runner/src/index.ts` export accordingly.

---

## Config Example

`engine/configs/software/context-packs/example-conventions.yaml` — a minimal example pack to make the feature testable end-to-end.

---

## Error Cases

| Scenario | Behavior |
|----------|----------|
| Pack name not found in `context-packs/` | Hard error, pipeline fails |
| File path in `files[]` not found in workspace | Hard error, pipeline fails |
| `packs: []` or `packs` omitted | No-op, no packs loaded |
| `workspacePath` not set but `files[]` non-empty | Hard error (no workspace to read from) |

---

## Packages Touched

| Package | Changes |
|---------|---------|
| `contracts` | New `context-pack.ts`, extend `StageDefinition`, extend `AgentContext` |
| `engine` | New `context-pack-loader.ts`, update `engine.ts` call site |
| `runner` | Update `prompt-builder.ts`, delete `context/context-pack.ts` |
| `configs` | Add `software/context-packs/example-conventions.yaml` |
