# Context Packs (STU-13) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add context packs — loadable YAML files with inline content and workspace file references — injectable into any stage prompt via `packs: [...]` in pipeline YAML.

**Architecture:** Engine resolves pack names → YAML files → reads workspace files → produces `ResolvedContextPack[]` → stored in `AgentContext.context_packs` → runner formats each as a distinct `##` section in the LLM prompt. Contracts holds shared types; engine handles loading; runner handles formatting.

**Tech Stack:** TypeScript, js-yaml (already in engine), Node.js fs/promises (already in runner), `@studio-foundation/contracts` (shared types).

**Execution order:** contracts → runner → engine (+ configs). Each is a separate git repo with its own branch and PR.

---

### Task 1: Branch in contracts

**Files:**
- Repo: `contracts/`

**Step 1: Create branch**
```bash
cd /home/arianeguay/dev/src/Studio/contracts
git checkout -b feat/stu-13-context-packs
```
Expected: `Switched to a new branch 'feat/stu-13-context-packs'`

---

### Task 2: Add context pack types to contracts

**Files:**
- Create: `contracts/src/context-pack.ts`
- Modify: `contracts/src/pipeline.ts` (lines 26-28)
- Modify: `contracts/src/index.ts`

**Step 1: Create the types file**

Create `contracts/src/context-pack.ts`:

```typescript
// Shared types for the context packs feature (STU-13)

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

**Step 2: Extend StageDefinition.context**

In `contracts/src/pipeline.ts`, replace lines 26-28:

```typescript
  context?: {
    include: string[];
    packs?: string[];
  };
```

**Step 3: Add to barrel export**

In `contracts/src/index.ts`, add after the last `export *` line:

```typescript
export * from './context-pack.js';
```

**Step 4: Build**
```bash
cd /home/arianeguay/dev/src/Studio/contracts && npm run build
```
Expected: Build succeeds with no errors.

**Step 5: Commit**
```bash
cd /home/arianeguay/dev/src/Studio/contracts
git add src/context-pack.ts src/index.ts src/pipeline.ts
git commit -m "feat(contracts): add context pack types and extend StageDefinition"
```

**Step 6: Push + PR**
```bash
cd /home/arianeguay/dev/src/Studio/contracts
git push -u origin feat/stu-13-context-packs
gh pr create --title "feat(contracts): context pack types for STU-13" --body "$(cat <<'EOF'
## Quoi
Ajoute les types pour le système de context packs (STU-13) :
- `ContextPackDefinition` — structure du fichier YAML de pack
- `ResolvedContextPack` — pack résolu (sections prêtes à injecter dans le prompt)
- `StageDefinition.context.packs?: string[]` — champ pour référencer des packs dans un stage

## Pourquoi
STU-13 — Shared types used by both engine (loading) and runner (formatting).

## Packages touchés
- `@studio-foundation/contracts`

## Comment tester
Build passe. `ContextPackDefinition` et `ResolvedContextPack` sont exportés. `StageDefinition.context` accepte `packs?: string[]`.
EOF
)" --base main
```

---

### Task 3: Branch in runner

**Step 1: Create branch**
```bash
cd /home/arianeguay/dev/src/Studio/runner
git checkout -b feat/stu-13-context-packs
```
Expected: `Switched to a new branch 'feat/stu-13-context-packs'`

---

### Task 4: Extend AgentContext + add prompt formatting for packs

**Files:**
- Modify: `runner/src/prompt-builder.ts`
- Test: find or create test file for prompt-builder (check `ls runner/src/__tests__/` or look for `*.test.ts`)

**Step 1: Find the test file location**
```bash
find /home/arianeguay/dev/src/Studio/runner -name "*.test.ts" | head -20
```
Note the pattern and either add to an existing prompt-builder test file or create one at that location.

**Step 2: Write failing tests for context_packs formatting**

In the prompt-builder test file, add:

```typescript
describe('buildPrompt - context_packs', () => {
  it('renders each pack as its own ## section with description', () => {
    const messages = buildPrompt({
      agent: { name: 'test', system_prompt: 'You are helpful.', provider: 'mock', model: 'mock' } as any,
      task: { description: 'Do the task.' },
      context: {
        context_packs: [
          {
            name: 'React Conventions',
            description: 'React coding standards',
            sections: [
              { title: 'Naming conventions', content: '- Components: PascalCase' },
            ],
          },
        ],
      },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    expect(userContent).toContain('## React Conventions — React coding standards');
    expect(userContent).toContain('### Naming conventions');
    expect(userContent).toContain('- Components: PascalCase');
    // Pack appears before ## Task
    expect(userContent.indexOf('## React Conventions')).toBeLessThan(userContent.indexOf('## Task'));
  });

  it('renders pack without description (no dash suffix)', () => {
    const messages = buildPrompt({
      agent: { name: 'test', system_prompt: 'You are helpful.', provider: 'mock', model: 'mock' } as any,
      task: { description: 'Do the task.' },
      context: {
        context_packs: [
          {
            name: 'Testing Standards',
            sections: [{ title: 'Coverage', content: 'Aim for 80%.' }],
          },
        ],
      },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    expect(userContent).toContain('## Testing Standards\n\n');
    expect(userContent).not.toContain('## Testing Standards —');
  });

  it('renders multiple packs in order', () => {
    const messages = buildPrompt({
      agent: { name: 'test', system_prompt: 'You are helpful.', provider: 'mock', model: 'mock' } as any,
      task: { description: 'Do the task.' },
      context: {
        context_packs: [
          { name: 'Pack A', sections: [{ title: 'A', content: 'a' }] },
          { name: 'Pack B', sections: [{ title: 'B', content: 'b' }] },
        ],
      },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    expect(userContent.indexOf('## Pack A')).toBeLessThan(userContent.indexOf('## Pack B'));
  });

  it('skips pack rendering when context_packs is empty or absent', () => {
    const messages = buildPrompt({
      agent: { name: 'test', system_prompt: 'You are helpful.', provider: 'mock', model: 'mock' } as any,
      task: { description: 'Do the task.' },
      context: { context_packs: [] },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    // Only ## Task should be present (no pack ## headers)
    const headers = [...userContent.matchAll(/^## /gm)];
    expect(headers).toHaveLength(1);
  });
});
```

**Step 3: Run tests to confirm failure**
```bash
cd /home/arianeguay/dev/src/Studio/runner && npm test
```
Expected: Tests fail — `context_packs` does not exist on `AgentContext`.

**Step 4: Extend AgentContext in prompt-builder.ts**

In `runner/src/prompt-builder.ts`:

Add import at top (after line 5):
```typescript
import type { ResolvedContextPack } from '@studio-foundation/contracts';
```

Replace the `AgentContext` interface (lines 21-24):
```typescript
export interface AgentContext {
  previous_outputs?: Record<string, unknown>;
  repo_files?: string[];
  additional_context?: string;
  context_packs?: ResolvedContextPack[];
}
```

**Step 5: Add pack rendering in buildPrompt**

In `runner/src/prompt-builder.ts`, after the `additional_context` block (after line 124) and before `// Add task description` (line 126), insert:

```typescript
  // Add context packs — each as a top-level ## section, sections as ###
  if (context.context_packs?.length) {
    for (const pack of context.context_packs) {
      userContent += `## ${pack.name}`;
      if (pack.description) userContent += ` — ${pack.description}`;
      userContent += '\n\n';
      for (const section of pack.sections) {
        userContent += `### ${section.title}\n\n${section.content}\n\n`;
      }
    }
  }
```

**Step 6: Run tests to confirm they pass**
```bash
cd /home/arianeguay/dev/src/Studio/runner && npm test
```
Expected: All tests pass.

**Step 7: Commit**
```bash
cd /home/arianeguay/dev/src/Studio/runner
git add src/prompt-builder.ts
git add src/__tests__/  # or wherever the test file lives
git commit -m "feat(runner): extend AgentContext with context_packs and add prompt formatting"
```

---

### Task 5: Delete unused context-pack.ts from runner

**Files:**
- Delete: `runner/src/context/context-pack.ts`
- Modify: `runner/src/index.ts` (remove lines 40-42)

**Step 1: Check no one imports this file**
```bash
grep -r "context-pack\|buildContextPack\|ContextPackConfig" \
  /home/arianeguay/dev/src/Studio/runner/src \
  /home/arianeguay/dev/src/Studio/engine/src \
  /home/arianeguay/dev/src/Studio/cli/src 2>/dev/null
```
Expected: Only the files we're about to delete/clean up.

**Step 2: Delete the file**
```bash
rm /home/arianeguay/dev/src/Studio/runner/src/context/context-pack.ts
```

**Step 3: Remove the export from runner/src/index.ts**

In `runner/src/index.ts`, remove the entire `// Context` section (lines 40-42):
```typescript
// Context
export { buildContextPack } from './context/context-pack.js';
export type { ContextPack, ContextPackConfig } from './context/context-pack.js';
```

**Step 4: Build to confirm clean**
```bash
cd /home/arianeguay/dev/src/Studio/runner && npm run build
```
Expected: Build succeeds, no broken imports.

**Step 5: Commit + push + PR**
```bash
cd /home/arianeguay/dev/src/Studio/runner
git add -A
git commit -m "chore(runner): delete unused context-pack.ts"
git push -u origin feat/stu-13-context-packs
gh pr create --title "feat(runner): context_packs in AgentContext + prompt formatting (STU-13)" --body "$(cat <<'EOF'
## Quoi
- Étend `AgentContext` avec `context_packs?: ResolvedContextPack[]`
- Formate chaque pack comme une section `##` distincte dans le prompt LLM (sous-sections `###` par entry)
- Supprime `context/context-pack.ts` (inutilisé, remplacé par le loader côté engine)

## Pourquoi
STU-13 — Rich context packs. Le runner reçoit les packs déjà résolus de l'engine et les formate dans le prompt.

## Packages touchés
- `@studio-foundation/runner`

## Comment tester
`npm test` dans runner passe. Un stage avec `context_packs` voit ses packs dans le prompt avant `## Task`.
EOF
)" --base main
```

---

### Task 6: Branch in engine

**Step 1: Create branch**
```bash
cd /home/arianeguay/dev/src/Studio/engine
git checkout -b feat/stu-13-context-packs
```
Expected: `Switched to a new branch 'feat/stu-13-context-packs'`

---

### Task 7: Create context-pack-loader.ts with tests

**Files:**
- Create: `engine/src/pipeline/context-pack-loader.ts`
- Test: find existing test patterns first (`find /home/arianeguay/dev/src/Studio/engine -name "*.test.ts" | head -5`), then create test file at that pattern

**Step 1: Find existing test file location**
```bash
find /home/arianeguay/dev/src/Studio/engine -name "*.test.ts" | head -10
```
Note the directory pattern (likely `engine/src/__tests__/` or `engine/src/pipeline/__tests__/`).

**Step 2: Write failing tests**

Create the test file at the appropriate location (e.g., `engine/src/pipeline/__tests__/context-pack-loader.test.ts`):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'; // or jest — check package.json
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { loadContextPacks } from '../context-pack-loader.js';

describe('loadContextPacks', () => {
  let tmpDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-packs-'));
    workspaceDir = path.join(tmpDir, 'workspace');
    await fs.mkdir(path.join(tmpDir, 'context-packs'), { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('loads a pack with only inline sections', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'context-packs', 'coding-standards.yaml'),
      `name: Coding Standards\ndescription: Our standards\nversion: 1\ninline:\n  - title: "Naming"\n    content: "Use camelCase"\n  - title: "Errors"\n    content: "Always catch"`
    );

    const result = await loadContextPacks(['coding-standards'], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Coding Standards');
    expect(result[0].description).toBe('Our standards');
    expect(result[0].sections).toHaveLength(2);
    expect(result[0].sections[0]).toEqual({ title: 'Naming', content: 'Use camelCase' });
  });

  it('loads a pack with file sections read from workspace', async () => {
    await fs.writeFile(path.join(workspaceDir, 'STYLE.md'), '# Style Guide\nUse tabs.');
    await fs.writeFile(
      path.join(tmpDir, 'context-packs', 'style.yaml'),
      `name: Style Guide\nversion: 1\nfiles:\n  - path: STYLE.md`
    );

    const result = await loadContextPacks(['style'], tmpDir, workspaceDir);

    expect(result[0].sections).toHaveLength(1);
    expect(result[0].sections[0].title).toBe('STYLE.md');
    expect(result[0].sections[0].content).toContain('# Style Guide');
  });

  it('puts file sections before inline sections', async () => {
    await fs.writeFile(path.join(workspaceDir, 'README.md'), 'Read me.');
    await fs.writeFile(
      path.join(tmpDir, 'context-packs', 'mixed.yaml'),
      `name: Mixed\nversion: 1\nfiles:\n  - path: README.md\ninline:\n  - title: "Rule"\n    content: "Follow rules"`
    );

    const result = await loadContextPacks(['mixed'], tmpDir, workspaceDir);

    expect(result[0].sections[0].title).toBe('README.md');
    expect(result[0].sections[1].title).toBe('Rule');
  });

  it('throws a clear error when pack file does not exist', async () => {
    await expect(
      loadContextPacks(['nonexistent'], tmpDir)
    ).rejects.toThrow(/context pack.*nonexistent.*not found/i);
  });

  it('throws a clear error when referenced workspace file does not exist', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'context-packs', 'bad-pack.yaml'),
      `name: Bad Pack\nversion: 1\nfiles:\n  - path: missing-file.md`
    );

    await expect(
      loadContextPacks(['bad-pack'], tmpDir, workspaceDir)
    ).rejects.toThrow(/file.*missing-file\.md.*not found/i);
  });

  it('throws when files[] referenced but workspacePath not provided', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'context-packs', 'needs-ws.yaml'),
      `name: Needs WS\nversion: 1\nfiles:\n  - path: some.md`
    );

    await expect(
      loadContextPacks(['needs-ws'], tmpDir, undefined)
    ).rejects.toThrow(/workspace.*not configured/i);
  });

  it('loads multiple packs preserving order', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'context-packs', 'pack-a.yaml'),
      `name: Pack A\nversion: 1\ninline:\n  - title: A\n    content: a`
    );
    await fs.writeFile(
      path.join(tmpDir, 'context-packs', 'pack-b.yaml'),
      `name: Pack B\nversion: 1\ninline:\n  - title: B\n    content: b`
    );

    const result = await loadContextPacks(['pack-a', 'pack-b'], tmpDir);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Pack A');
    expect(result[1].name).toBe('Pack B');
  });

  it('returns empty array when packNames is empty', async () => {
    const result = await loadContextPacks([], tmpDir);
    expect(result).toEqual([]);
  });
});
```

**Step 3: Run tests to confirm failure**
```bash
cd /home/arianeguay/dev/src/Studio/engine && npm test
```
Expected: Test file compiles but fails — `loadContextPacks` not found.

**Step 4: Implement context-pack-loader.ts**

Create `engine/src/pipeline/context-pack-loader.ts`:

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { ContextPackDefinition, ResolvedContextPack } from '@studio-foundation/contracts';

export async function loadContextPacks(
  packNames: string[],
  projectConfigPath: string,
  workspacePath?: string,
): Promise<ResolvedContextPack[]> {
  if (packNames.length === 0) return [];

  const packsDir = path.join(projectConfigPath, 'context-packs');
  const results: ResolvedContextPack[] = [];

  for (const packName of packNames) {
    const packFile = path.join(packsDir, `${packName}.yaml`);

    let rawContent: string;
    try {
      rawContent = await fs.readFile(packFile, 'utf-8');
    } catch {
      throw new Error(`Context pack "${packName}" not found at ${packFile}`);
    }

    const definition = yaml.load(rawContent) as ContextPackDefinition;
    const sections: Array<{ title: string; content: string }> = [];

    // File sections first (in YAML order)
    if (definition.files?.length) {
      if (!workspacePath) {
        throw new Error(
          `Context pack "${packName}" references files but workspace is not configured`
        );
      }
      for (const fileRef of definition.files) {
        const filePath = path.join(workspacePath, fileRef.path);
        let content: string;
        try {
          content = await fs.readFile(filePath, 'utf-8');
        } catch {
          throw new Error(`File "${fileRef.path}" not found in workspace at ${filePath}`);
        }
        sections.push({ title: fileRef.path, content });
      }
    }

    // Inline sections after (in YAML order)
    if (definition.inline?.length) {
      for (const inline of definition.inline) {
        sections.push({ title: inline.title, content: inline.content });
      }
    }

    results.push({
      name: definition.name,
      ...(definition.description !== undefined && { description: definition.description }),
      sections,
    });
  }

  return results;
}
```

**Step 5: Run tests to confirm they pass**
```bash
cd /home/arianeguay/dev/src/Studio/engine && npm test
```
Expected: All tests pass.

**Step 6: Commit**
```bash
cd /home/arianeguay/dev/src/Studio/engine
git add src/pipeline/context-pack-loader.ts
git add src/pipeline/__tests__/  # adjust path to match actual test location
git commit -m "feat(engine): add context-pack-loader with tests"
```

---

### Task 8: Wire pack loading into engine.ts

**Files:**
- Modify: `engine/src/engine.ts`

**Step 1: Check what `paths` object contains at the getContextForStage call site**

Read `engine/src/engine.ts` around lines 310-340 to find:
- How `paths` is structured (look for `agentsDir`, `contractsDir` — what is their parent dir called?)
- What variable holds the project config root (e.g., `paths.configDir`, `paths.projectDir`, or similar)

The project config root is the directory containing `context-packs/`, `agents/`, `contracts/` — e.g., `engine/configs/software/`.

**Step 2: Add import**

In `engine/src/engine.ts`, add to the imports section:
```typescript
import { loadContextPacks } from './pipeline/context-pack-loader.js';
```

**Step 3: Insert pack loading after getContextForStage (line 335)**

After line 335:
```typescript
const agentContext = getContextForStage(pipelineContext, stageDef, previousStageName);
```

Add:
```typescript
  // Load context packs if stage defines any
  if (stageDef.context?.packs?.length) {
    agentContext.context_packs = await loadContextPacks(
      stageDef.context.packs,
      paths.configDir,       // adjust to the actual variable holding engine/configs/<project>/
      pipelineContext.repoPath,
    );
  }
```

> **Note:** If the variable name is different (e.g., `paths.projectRoot`, `projectConfigPath`, etc.), adjust accordingly. The goal is to pass the directory that contains `context-packs/` alongside `agents/` and `contracts/`.

**Step 4: Build**
```bash
cd /home/arianeguay/dev/src/Studio/engine && npm run build
```
Expected: Build succeeds with no type errors.

**Step 5: Commit**
```bash
cd /home/arianeguay/dev/src/Studio/engine
git add src/engine.ts
git commit -m "feat(engine): wire context pack loading into stage execution"
```

---

### Task 9: Add example config + update feature-builder pipeline

**Files:**
- Create: `engine/configs/software/context-packs/example-conventions.yaml`
- Modify: `engine/configs/software/pipelines/feature-builder.pipeline.yaml`

**Step 1: Create the example pack**

Create `engine/configs/software/context-packs/example-conventions.yaml`:

```yaml
name: Example Conventions
description: Sample coding standards for the software project
version: 1

inline:
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

**Step 2: Add pack to code-generation stage in feature-builder.pipeline.yaml**

In `engine/configs/software/pipelines/feature-builder.pipeline.yaml`, the code-generation stage context (currently lines 49-54) becomes:

```yaml
        context:
          include:
            - input
            - all_stage_outputs
            - repo_files
            - group_feedback
          packs:
            - example-conventions
```

**Step 3: Commit**
```bash
cd /home/arianeguay/dev/src/Studio/engine
git add configs/software/context-packs/example-conventions.yaml
git add configs/software/pipelines/feature-builder.pipeline.yaml
git commit -m "feat(configs): add example context pack for software project"
```

---

### Task 10: Full build, test, push + PR for engine

**Step 1: Full rebuild**
```bash
cd /home/arianeguay/dev/src/Studio/engine && npm run build
```
Expected: Clean build.

**Step 2: Run all engine tests**
```bash
cd /home/arianeguay/dev/src/Studio/engine && npm test
```
Expected: All tests pass including the new loader tests.

**Step 3: Push + PR**
```bash
cd /home/arianeguay/dev/src/Studio/engine
git push -u origin feat/stu-13-context-packs
gh pr create --title "feat(engine): context pack loading for STU-13" --body "$(cat <<'EOF'
## Quoi
- Nouveau `context-pack-loader.ts` : charge les packs YAML depuis `<project>/context-packs/`, lit les fichiers workspace, assemble des `ResolvedContextPack[]`. Erreur claire si pack ou fichier manquant.
- `engine.ts` : appelle le loader après `getContextForStage()`, injecte les packs dans `agentContext.context_packs`
- Config : `example-conventions.yaml` + usage dans `feature-builder.pipeline.yaml` pour smoke test

## Pourquoi
STU-13 — Rich context packs. Les agents peuvent maintenant recevoir des conventions, standards, et docs de projet directement dans leur prompt via `packs: [...]` dans le pipeline YAML.

## Packages touchés
- `@studio-foundation/engine`
- `engine/configs/software/`

## Comment tester
1. `npm test` dans engine passe (tests unitaires du loader)
2. `studio run software/feature-builder --input-file engine/configs/software/inputs/faq-about.input.yaml` — inspecter les logs : le prompt du stage code-generation doit inclure `## Example Conventions`
EOF
)" --base main
```

---

## Checklist de fin de task

```
[ ] contracts: branche feat/stu-13-context-packs créée
[ ] contracts: context-pack.ts avec ContextPackDefinition + ResolvedContextPack
[ ] contracts: StageDefinition.context étendu avec packs?: string[]
[ ] contracts: index.ts barrel mis à jour
[ ] contracts: build passe
[ ] contracts: PR créée → main

[ ] runner: branche feat/stu-13-context-packs créée
[ ] runner: AgentContext étendu avec context_packs?: ResolvedContextPack[]
[ ] runner: prompt-builder formate les packs comme sections ## / ###
[ ] runner: tests passent (4 cas couverts)
[ ] runner: context/context-pack.ts supprimé
[ ] runner: index.ts exports nettoyés
[ ] runner: build passe
[ ] runner: PR créée → main

[ ] engine: branche feat/stu-13-context-packs créée
[ ] engine: context-pack-loader.ts avec 7 tests unitaires
[ ] engine: engine.ts câblé (import + appel après getContextForStage)
[ ] engine: example-conventions.yaml créé
[ ] engine: feature-builder.pipeline.yaml mis à jour
[ ] engine: build passe
[ ] engine: tous les tests passent
[ ] engine: PR créée → main
```
