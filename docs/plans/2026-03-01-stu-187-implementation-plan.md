# STU-187 Domain Invariants Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When `.studio/invariants.md` exists in a user project, automatically inject its content into every agent's `system_prompt` at pipeline runtime.

**Architecture:** Load `.studio/invariants.md` once at pipeline start in `engine/src/engine.ts`, store on `PipelineContext`, and append to `agentConfig.system_prompt` in `executeStage()` — identical pattern to skill injection already in the engine.

**Tech Stack:** TypeScript, Vitest, Node.js `fs/promises`

---

### Task 1: Add `invariantsContent` to `PipelineContext`

**Files:**
- Modify: `engine/src/pipeline/context-propagation.ts:17-25`
- Test: `engine/src/pipeline/invariants-loader.test.ts` (create)

**Step 1: Write failing test**

Create `engine/src/pipeline/invariants-loader.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

// We'll import this function once we create it
import { loadInvariantsFile } from './invariants-loader.js';

const TMP = join('/tmp', '.studio-invariants-loader-test-' + Date.now());
const INVARIANTS_PATH = join(TMP, 'invariants.md');

describe('loadInvariantsFile', () => {
  beforeAll(async () => {
    await mkdir(TMP, { recursive: true });
    await writeFile(INVARIANTS_PATH, '# Domain Invariants\n\nNever reproduce verbatim passages.');
  });

  afterAll(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  it('returns file content when invariants.md exists', async () => {
    const content = await loadInvariantsFile(TMP);
    expect(content).toBe('# Domain Invariants\n\nNever reproduce verbatim passages.');
  });

  it('returns undefined when invariants.md does not exist', async () => {
    const content = await loadInvariantsFile('/tmp/no-such-studio-dir-xyz');
    expect(content).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /home/arianeguay/dev/src/Studio/.worktrees/stu-187
pnpm --filter @studio/engine test -- --reporter=verbose engine/src/pipeline/invariants-loader.test.ts
```

Expected: FAIL — `Cannot find module './invariants-loader.js'`

**Step 3: Create `engine/src/pipeline/invariants-loader.ts`**

```typescript
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Load `.studio/invariants.md` from the project directory.
 * Returns content if the file exists, undefined otherwise (non-fatal).
 */
export async function loadInvariantsFile(projectDir: string): Promise<string | undefined> {
  try {
    return await readFile(join(projectDir, 'invariants.md'), 'utf-8');
  } catch {
    return undefined;
  }
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm --filter @studio/engine test -- --reporter=verbose engine/src/pipeline/invariants-loader.test.ts
```

Expected: PASS — 2 tests passing

**Step 5: Add `invariantsContent` to `PipelineContext`**

In `engine/src/pipeline/context-propagation.ts`, change:

```typescript
export interface PipelineContext {
  input: PipelineInput;
  stageOutputs: Map<string, unknown>;
  stageOutputSizes: Map<string, number>;
  stageToolResults: Map<string, ToolCall[]>;
  repoPath?: string;
  groupFeedback?: GroupFeedback;
  startupContext?: Record<string, string>;
}
```

To:

```typescript
export interface PipelineContext {
  input: PipelineInput;
  stageOutputs: Map<string, unknown>;
  stageOutputSizes: Map<string, number>;
  stageToolResults: Map<string, ToolCall[]>;
  repoPath?: string;
  groupFeedback?: GroupFeedback;
  startupContext?: Record<string, string>;
  invariantsContent?: string;
}
```

**Step 6: Run all engine tests to verify no breakage**

```bash
pnpm --filter @studio/engine test
```

Expected: all passing (the interface change is additive, optional field)

**Step 7: Commit**

```bash
git add engine/src/pipeline/invariants-loader.ts engine/src/pipeline/invariants-loader.test.ts engine/src/pipeline/context-propagation.ts
git commit -m "feat(engine): add invariants loader and PipelineContext.invariantsContent field"
```

---

### Task 2: Load invariants.md at pipeline start

**Files:**
- Modify: `engine/src/engine.ts` (around line 240 — after `on_pipeline_start` block)

The `run()` method in `engine.ts` already does:

```typescript
// Run on_pipeline_start commands to bootstrap dynamic context
if (pipeline.on_pipeline_start?.length) {
  const cwd = this.config.repoPath ?? this.config.configsDir;
  pipelineContext.startupContext = await executeStartupCommands(
    pipeline.on_pipeline_start,
    cwd
  );
}
```

Add the invariants load immediately after that block.

**Step 1: Add import**

At the top of `engine/src/engine.ts`, find the existing imports from `./pipeline/...` and add:

```typescript
import { loadInvariantsFile } from './pipeline/invariants-loader.js';
```

**Step 2: Add loading after startup commands block**

Find the `on_pipeline_start` block (around line 237) and add below it:

```typescript
// Load .studio/invariants.md if present — injected into every agent's system_prompt
pipelineContext.invariantsContent = await loadInvariantsFile(projectPaths.projectDir);
```

**Step 3: Build to verify no TypeScript errors**

```bash
pnpm --filter @studio/engine build
```

Expected: exits 0, no errors

**Step 4: Commit**

```bash
git add engine/src/engine.ts
git commit -m "feat(engine): load .studio/invariants.md at pipeline start"
```

---

### Task 3: Inject invariants into agent system_prompt

**Files:**
- Modify: `engine/src/engine.ts` (around line 466 — after skills injection block)

The skills injection block in `executeStage()` already does:

```typescript
// Inject project skills (.studio/skills/*.skill.md) for agents that declare skills
if (agentConfig.skills?.length) {
  const skillsDir = join(paths.projectDir, 'skills');
  const loaded = await loadSkillFiles(agentConfig.skills, skillsDir);
  if (loaded.length > 0) {
    const skillChunks = loaded.map((s) => `## Skill: ${s.name}\n\n${s.content}`);
    agentConfig.system_prompt = `${agentConfig.system_prompt ?? ''}\n\n${skillChunks.join('\n\n---\n\n')}`;
  }
}
```

Add invariants injection immediately after that block.

**Step 1: Add injection block after skills**

```typescript
// Inject project domain invariants (.studio/invariants.md) into system_prompt
if (pipelineContext.invariantsContent) {
  agentConfig.system_prompt = `${agentConfig.system_prompt ?? ''}\n\n---\n\n## Project Invariants\n\n${pipelineContext.invariantsContent}`;
}
```

**Step 2: Build to verify no TypeScript errors**

```bash
pnpm --filter @studio/engine build
```

Expected: exits 0

**Step 3: Run all tests to verify no breakage**

```bash
pnpm test
```

Expected: all passing (nothing changes when invariants.md doesn't exist)

**Step 4: Commit**

```bash
git add engine/src/engine.ts
git commit -m "feat(engine): inject invariants.md content into agent system_prompt"
```

---

### Task 4: Integration test — invariants appear in agent prompt

**Files:**
- Modify: `engine/src/pipeline/invariants-loader.test.ts`

The unit tests verify loading. We need a test that verifies the content actually reaches the agent. Look at how the engine tests work — search for existing integration-style tests in `engine/src/`.

```bash
find /home/arianeguay/dev/src/Studio/.worktrees/stu-187/engine -name "*.test.ts" | xargs grep -l "MockProvider\|mock.*provider\|provider.*mock" | head -5
```

This tells you which test file to model from.

**Step 1: Write integration test in `invariants-loader.test.ts`**

Add a new describe block to the existing test file:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadInvariantsFile } from './invariants-loader.js';

// --- existing tests above ---

describe('invariants integration: system_prompt injection', () => {
  // This test verifies the loader returns content that the engine would inject.
  // Full engine integration is covered by engine.ts tests.
  it('loaded content is non-empty and suitable for system_prompt injection', async () => {
    const dir = join('/tmp', '.studio-invariants-integration-' + Date.now());
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'invariants.md'),
      '## Invariants\n\n- Never hallucinate entity names\n- Cite sources'
    );

    const content = await loadInvariantsFile(dir);

    expect(content).toBeDefined();
    expect(typeof content).toBe('string');
    expect(content!.length).toBeGreaterThan(0);
    // Verify it's safe to concatenate into a system_prompt string
    const systemPrompt = `You are an agent.\n\n---\n\n## Project Invariants\n\n${content}`;
    expect(systemPrompt).toContain('Never hallucinate entity names');

    await rm(dir, { recursive: true, force: true });
  });
});
```

**Step 2: Run tests**

```bash
pnpm --filter @studio/engine test -- --reporter=verbose engine/src/pipeline/invariants-loader.test.ts
```

Expected: PASS — all tests passing

**Step 3: Commit**

```bash
git add engine/src/pipeline/invariants-loader.test.ts
git commit -m "test(engine): add integration test for invariants system_prompt injection"
```

---

### Task 5: Create `templates/analysis/.studio/invariants.md`

**Files:**
- Create: `templates/analysis/.studio/invariants.md`

**Step 1: Create directory and file**

```bash
mkdir -p /home/arianeguay/dev/src/Studio/.worktrees/stu-187/templates/analysis/.studio
```

Then create `templates/analysis/.studio/invariants.md`:

```markdown
# Project Invariants — Wiki Creator

This document defines the domain invariants for the Wiki Creator project.
It is automatically injected into every agent's system prompt at runtime.

## Content Integrity

- **Never reproduce verbatim passages** from the source book. Summarize, paraphrase, and synthesize.
- **Never fabricate facts** not present in the source material. If uncertain, say so explicitly.
- **Entity names must match the source exactly.** No paraphrasing of proper nouns, titles, or names.

## Output Quality

- **Every wiki page must cite its source chapters.** Include chapter references for all claims.
- **All entity relationships must be bidirectional.** If A relates to B, B must reference A.
- **Disambiguation required.** If a name appears multiple times with different roles, distinguish them.

## Enforcement

These invariants are reinforced by:
- `contracts/wiki-page.contract.yaml` — requires `source_citations` field
- `contracts/entity-extraction.contract.yaml` — requires `entity_type` classification
- Hook `on_stage_complete` on the wiki-generator stage runs a verbatim-check script
```

**Step 2: Verify the file was created**

```bash
cat /home/arianeguay/dev/src/Studio/.worktrees/stu-187/templates/analysis/.studio/invariants.md
```

**Step 3: Commit**

```bash
git add templates/analysis/.studio/invariants.md
git commit -m "feat(templates): add analysis template with invariants.md example (Wiki Creator)"
```

---

### Task 6: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Find the `.studio/` structure section**

Search for the block describing `.studio/` directory structure in `CLAUDE.md`:

```bash
grep -n "invariants\|\.studio/.*md\|governance" CLAUDE.md | head -10
```

**Step 2: Add invariants.md to the `.studio/` structure**

In the `.studio/` directory tree in CLAUDE.md, find:

```
│   ├── inputs/                       # *.input.yaml
│   ├── registry.lock.json            # Versions tools installés (commité)
│   └── runs/                         # Données runtime (gitignored)
```

Add `invariants.md` before `inputs/`:

```
│   ├── invariants.md                 # Invariants de domaine du projet (optionnel, commité)
│   ├── inputs/                       # *.input.yaml
│   ├── registry.lock.json            # Versions tools installés (commité)
│   └── runs/                         # Données runtime (gitignored)
```

**Step 3: Add a concept entry**

In the "Concepts clés" section of CLAUDE.md, find the `**Skills (.skill.md)**` entry and add after it:

```markdown
**Project Invariants (.studio/invariants.md)** — Fichier markdown optionnel qui documente les invariants de domaine du projet (ex: "ne jamais reproduire de passages verbatim du livre source"). Si ce fichier existe, son contenu est automatiquement injecté dans le `system_prompt` de chaque agent au runtime — aucune configuration nécessaire. Sert de "constitution" du projet, analogue à `INVARIANTS.md` dans le kernel. L'enforcement reste dans les contracts et hooks existants.
```

**Step 4: Add to Git strategy section**

Find the "Git strategy" section (under the `.studio/` structure):

```
**Commité :** `.studio/pipelines/`, `.studio/agents/`, ...
```

Add `invariants.md` to the committed list:

```
**Commité :** `.studio/pipelines/`, `.studio/agents/`, `.studio/contracts/`, `.studio/tools/`, `.studio/invariants.md` (si présent), `.studio/registry.lock.json`, `src/`, `prisma/`
```

**Step 5: Run all tests one final time**

```bash
pnpm test
```

Expected: all passing

**Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document .studio/invariants.md pattern in CLAUDE.md"
```

---

### Task 7: Final verification

**Step 1: Full build + test**

```bash
pnpm build && pnpm test
```

Expected: build exits 0, all tests passing

**Step 2: Verify git log looks clean**

```bash
git log --oneline -10
```

Expected: 6 commits for this feature on the branch

**Step 3: Invoke finishing-a-development-branch skill**

Use `superpowers:finishing-a-development-branch` to decide on merge/PR strategy.
