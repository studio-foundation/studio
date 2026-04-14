# Repo Clone + Structured Input — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add auto-clone of git repos and structured YAML input files to the Studio pipeline runner.

**Architecture:** The CLI handles all I/O (git clone, input file parsing) before calling the engine. The engine's `RunInput.input` type widens from `string` to `string | Record<string, unknown>`. The prompt builder formats structured input as readable YAML in the prompt.

**Tech Stack:** TypeScript, js-yaml (already installed), child_process for git clone, commander (already installed)

---

### Task 1: Add `repo` field to PipelineDefinition type

**Files:**
- Modify: `contracts/src/pipeline.ts:5-10`
- Test: `contracts/tests/types.test.ts`

**Step 1: Update the type**

In `contracts/src/pipeline.ts`, add the `repo` field to `PipelineDefinition`:

```typescript
export interface PipelineDefinition {
  name: string;
  description: string;
  version: number;
  repo?: {
    url: string;
    branch?: string;
  };
  stages: StageDefinition[];
}
```

**Step 2: Add type test**

In `contracts/tests/types.test.ts`, add a test inside the existing `describe('contracts types', ...)`:

```typescript
it('can create pipeline with repo config', () => {
  const pipeline: PipelineDefinition = {
    name: 'test',
    description: 'Test',
    version: 1,
    repo: {
      url: 'https://github.com/test/repo',
      branch: 'main',
    },
    stages: [],
  };
  expect(pipeline.repo?.url).toBe('https://github.com/test/repo');
});
```

**Step 3: Build and test**

Run: `cd contracts && npm run build && npx vitest run`
Expected: Build passes, 6/6 tests pass

**Step 4: Commit**

```bash
git add contracts/src/pipeline.ts contracts/tests/types.test.ts
git commit -m "feat(contracts): add repo field to PipelineDefinition"
```

---

### Task 2: Add `projects_dir` to StudioConfig

**Files:**
- Modify: `cli/src/config.ts:10-14`

**Step 1: Add projects_dir to paths**

In `cli/src/config.ts`, update the `StudioConfig` interface:

```typescript
export interface StudioConfig {
  providers?: {
    openai?: { apiKey: string };
    anthropic?: { apiKey: string };
  };
  paths?: {
    pipelines?: string;
    contracts?: string;
    agents?: string;
    projects_dir?: string;
  };
  defaults?: {
    provider?: string;
    model?: string;
  };
}
```

**Step 2: Update config files**

In `.studiorc.yaml`, add:

```yaml
paths:
  pipelines: ./engine/pipelines
  contracts: ./engine/configs/contracts
  agents: ./engine/configs/agents
  projects_dir: ${STUDIO_PROJECTS_DIR}
```

In `.env.example`, add:

```
# Directory where repos are cloned for pipeline runs
STUDIO_PROJECTS_DIR=/path/to/studio-projects
```

**Step 3: Build CLI**

Run: `cd cli && npm run build`
Expected: Build passes

**Step 4: Commit**

```bash
git add cli/src/config.ts .studiorc.yaml .env.example
git commit -m "feat(cli): add projects_dir to StudioConfig"
```

---

### Task 3: Widen `RunInput.input` type in engine

**Files:**
- Modify: `engine/src/engine.ts:57-61`
- Modify: `engine/src/pipeline/context-propagation.ts:7-19`
- Test: `engine/tests/context-propagation.test.ts`

**Step 1: Write the failing test**

In `engine/tests/context-propagation.test.ts`, add a test (inside existing describe or new group):

```typescript
import { describe, it, expect } from 'vitest';
import { createInitialContext, getContextForStage } from '../src/pipeline/context-propagation.js';

describe('structured input', () => {
  it('passes structured input as YAML string in additional_context', () => {
    const structuredInput = {
      brief_summary: 'Add FAQ to About page',
      target_page: 'src/pages/about.tsx',
      acceptance_criteria: ['FAQ section appears', 'Accordion style'],
    };
    const context = createInitialContext(structuredInput);
    const agentCtx = getContextForStage(context, {
      name: 'test',
      kind: 'analysis',
      agent: 'test-agent',
      context: { include: ['input'] },
    });
    // Structured input should be serialized as YAML in additional_context
    expect(agentCtx.additional_context).toContain('brief_summary');
    expect(agentCtx.additional_context).toContain('Add FAQ to About page');
    expect(agentCtx.additional_context).toContain('target_page');
  });

  it('passes string input unchanged', () => {
    const context = createInitialContext('Simple string input');
    const agentCtx = getContextForStage(context, {
      name: 'test',
      kind: 'analysis',
      agent: 'test-agent',
      context: { include: ['input'] },
    });
    expect(agentCtx.additional_context).toBe('Simple string input');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd engine && npx vitest run tests/context-propagation.test.ts`
Expected: FAIL — `createInitialContext` only accepts `string`

**Step 3: Update RunInput type**

In `engine/src/engine.ts`, change:

```typescript
export interface RunInput {
  pipeline: string;
  input: string | Record<string, unknown>;
  meta?: Record<string, unknown>;
}
```

**Step 4: Update PipelineContext**

In `engine/src/pipeline/context-propagation.ts`:

```typescript
import * as yaml from 'js-yaml';
import type { StageDefinition } from '@studio-foundation/contracts';
import type { AgentContext } from '@studio-foundation/runner';

export type PipelineInput = string | Record<string, unknown>;

export interface PipelineContext {
  input: PipelineInput;
  stageOutputs: Map<string, unknown>;
  repoPath?: string;
}

export function createInitialContext(input: PipelineInput, repoPath?: string): PipelineContext {
  return {
    input,
    stageOutputs: new Map(),
    repoPath,
  };
}
```

Then update `getContextForStage`, in the `case 'input':` branch:

```typescript
case 'input':
  agentContext.additional_context = typeof context.input === 'string'
    ? context.input
    : yaml.dump(context.input, { lineWidth: 120 });
  break;
```

**Step 5: Run tests**

Run: `cd engine && npx vitest run`
Expected: All tests pass including new structured input tests

**Step 6: Build**

Run: `cd engine && npm run build`
Expected: Build passes

**Step 7: Commit**

```bash
git add engine/src/engine.ts engine/src/pipeline/context-propagation.ts engine/tests/context-propagation.test.ts
git commit -m "feat(engine): support structured input (string | Record)"
```

---

### Task 4: Add `--input-file` and `--repo-url` CLI options

**Files:**
- Modify: `cli/src/index.ts:18-26`
- Modify: `cli/src/commands/run.ts`

**Step 1: Add CLI options**

In `cli/src/index.ts`, update the run command definition:

```typescript
program
  .command('run <pipeline>')
  .description('Run a pipeline')
  .option('-i, --input <text>', 'Input description for the pipeline')
  .option('-f, --input-file <path>', 'Path to YAML input file')
  .option('-r, --repo <path>', 'Path to the target repository')
  .option('--repo-url <url>', 'Git URL to clone as target repository')
  .option('--config <path>', 'Path to .studiorc.yaml config file')
  .option('--json', 'Output results as JSON')
  .option('--verbose', 'Show detailed execution logs')
  .action(runCommand);
```

**Step 2: Update RunOptions interface**

In `cli/src/commands/run.ts`, update the interface:

```typescript
interface RunOptions {
  input?: string;
  inputFile?: string;
  repo?: string;
  repoUrl?: string;
  config?: string;
  json?: boolean;
  verbose?: boolean;
}
```

**Step 3: Build CLI**

Run: `cd cli && npm run build`
Expected: Build passes

**Step 4: Test help output**

Run: `studio run --help`
Expected: Shows `--input-file` and `--repo-url` options

**Step 5: Commit**

```bash
git add cli/src/index.ts cli/src/commands/run.ts
git commit -m "feat(cli): add --input-file and --repo-url options"
```

---

### Task 5: Implement input file loading in CLI

**Files:**
- Modify: `cli/src/commands/run.ts`

**Step 1: Add input resolution logic**

In `cli/src/commands/run.ts`, add at the top after existing imports:

```typescript
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
```

Then replace the input validation block (`if (!options.input)`) with:

```typescript
// Resolve input: --input-file takes precedence, --input as fallback
let input: string | Record<string, unknown>;

if (options.inputFile) {
  const inputPath = resolve(options.inputFile);
  let raw: string;
  try {
    raw = await readFile(inputPath, 'utf-8');
  } catch {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }
  const parsed = yaml.load(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    input = parsed as Record<string, unknown>;
  } else {
    console.error('Error: Input file must contain a YAML object (key-value pairs)');
    process.exit(1);
  }
} else if (options.input) {
  input = options.input;
} else {
  console.error('Error: --input or --input-file is required');
  process.exit(1);
}
```

Then update the `engine.run()` call to use the new `input` variable:

```typescript
const result = await engine.run({
  pipeline: pipelineName,
  input,
});
```

**Step 2: Build and test manually**

Run: `cd cli && npm run build`

Create a test input file `/tmp/test-input.yaml`:
```yaml
brief_summary: "Test input"
target_page: "src/pages/about.tsx"
```

Run: `studio run feature-builder --input-file /tmp/test-input.yaml --repo /tmp/some-repo`
Expected: Should attempt to run (may fail on LLM call, but should NOT fail on input parsing)

**Step 3: Commit**

```bash
git add cli/src/commands/run.ts
git commit -m "feat(cli): implement --input-file loading from YAML"
```

---

### Task 6: Implement repo clone logic in CLI

**Files:**
- Modify: `cli/src/commands/run.ts`

**Step 1: Add clone helper function**

In `cli/src/commands/run.ts`, add after imports:

```typescript
import { execSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPipelineByName } from '@studio-foundation/engine';
```

Add the clone function before `runCommand`:

```typescript
async function cloneRepo(
  repoUrl: string,
  projectsDir: string,
  pipelineName: string,
  branch?: string
): Promise<string> {
  // Create projects dir if it doesn't exist
  await mkdir(projectsDir, { recursive: true });

  // Generate timestamped folder name
  const timestamp = new Date().toISOString()
    .replace(/:/g, 'h')
    .replace(/\..+$/, '')
    .replace('T', 'T');
  const dirName = `${pipelineName}-${timestamp}`;
  const clonePath = join(projectsDir, dirName);

  // Clone
  const branchArg = branch ? `--branch ${branch}` : '';
  const cmd = `git clone --depth 1 ${branchArg} ${repoUrl} ${clonePath}`;

  try {
    execSync(cmd, { stdio: 'pipe' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to clone ${repoUrl}: ${msg}`);
  }

  return clonePath;
}
```

**Step 2: Add repo resolution logic**

In `runCommand`, after the input resolution block and before `const providerRegistry = ...`, add:

```typescript
// Resolve repo path: --repo > --repo-url > pipeline.repo.url > CWD
let repoPath: string;

if (options.repo) {
  // Explicit local path — use directly
  repoPath = resolve(options.repo);
} else {
  // Check if we need to clone
  const repoUrl = options.repoUrl;
  // We need the pipeline definition to check for repo.url
  const pipelinesDir = config.paths?.pipelines || './pipelines';
  const pipelineDef = await loadPipelineByName(pipelineName, pipelinesDir);
  const effectiveUrl = repoUrl || pipelineDef.repo?.url;
  const effectiveBranch = pipelineDef.repo?.branch;

  if (effectiveUrl) {
    // Need to clone — resolve projects dir
    const projectsDir = config.paths?.projects_dir || process.env.STUDIO_PROJECTS_DIR;
    if (!projectsDir) {
      console.error('Error: STUDIO_PROJECTS_DIR is not set. Set it in .env or .studiorc.yaml paths.projects_dir');
      process.exit(1);
    }

    console.log(`Cloning ${effectiveUrl}...`);
    repoPath = await cloneRepo(effectiveUrl, projectsDir, pipelineName, effectiveBranch);
    console.log(`Cloned to: ${repoPath}\n`);
  } else {
    repoPath = '.';
  }
}
```

Remove the old `const repoPath = options.repo || '.';` line.

**Step 3: Build**

Run: `cd cli && npm run build`
Expected: Build passes

**Step 4: Commit**

```bash
git add cli/src/commands/run.ts
git commit -m "feat(cli): implement repo clone from URL with STUDIO_PROJECTS_DIR"
```

---

### Task 7: Update pipeline loader to parse `repo` field

**Files:**
- Modify: `engine/src/pipeline/loader.ts:27-53`
- Test: `engine/tests/loader.test.ts`

**Step 1: Write failing test**

In `engine/tests/loader.test.ts`, add a test (inside existing describe for pipeline parsing):

```typescript
it('parses pipeline with repo config', () => {
  const yamlContent = `
name: test-pipeline
description: Test
version: 1
repo:
  url: https://github.com/test/repo
  branch: main
stages:
  - name: stage1
    kind: analysis
    agent: test-agent
`;
  const pipeline = parsePipelineYaml(yamlContent);
  expect(pipeline.repo?.url).toBe('https://github.com/test/repo');
  expect(pipeline.repo?.branch).toBe('main');
});

it('parses pipeline without repo config', () => {
  const yamlContent = `
name: test-pipeline
description: Test
version: 1
stages:
  - name: stage1
    kind: analysis
    agent: test-agent
`;
  const pipeline = parsePipelineYaml(yamlContent);
  expect(pipeline.repo).toBeUndefined();
});
```

**Step 2: Run test to verify it passes** (the parser uses `as unknown as PipelineDefinition` which includes any fields from YAML)

Run: `cd engine && npx vitest run tests/loader.test.ts`
Expected: Tests should already pass because the loader does a raw cast. If they fail, move to step 3.

**Step 3: Build and verify**

Run: `cd engine && npm run build && npx vitest run`
Expected: All tests pass

**Step 4: Commit**

```bash
git add engine/tests/loader.test.ts
git commit -m "test(engine): add tests for pipeline repo field parsing"
```

---

### Task 8: Update feature-builder pipeline YAML

**Files:**
- Modify: `engine/pipelines/feature-builder.pipeline.yaml`

**Step 1: Add repo field**

```yaml
name: feature-builder
description: Build a feature from a user description
version: 1

repo:
  url: https://github.com/arianeguay/pipelines-test-repo
  branch: main

stages:
  # ... rest unchanged
```

**Step 2: Commit**

```bash
git add engine/pipelines/feature-builder.pipeline.yaml
git commit -m "feat(engine): add repo URL to feature-builder pipeline"
```

---

### Task 9: Create test input file + full E2E smoke test

**Files:**
- Create: `engine/inputs/faq-about.input.yaml`

**Step 1: Create input file**

```yaml
brief_summary: "Ajouter une section FAQ simple a la page About, avec quelques questions/reponses, en respectant le style existant."
feature_brief: "Ajouter une section FAQ simple a la page About avec quelques questions/reponses en accord avec le style existant."
target_page: "src/pages/about.tsx"
acceptance_criteria:
  - "La section FAQ apparait sur la page About sans casser la mise en page."
  - "Chaque question est affichee comme un accordeon avec ouverture/fermeture."
  - "Le style (typographie, espacements, couleurs) est coherent avec le design existant."
  - "Aucune regression: build et tests passent."
sample_faq:
  - question: "C'est quoi ce projet?"
    answer: "Une breve description du site/projet."
  - question: "Comment me contacter?"
    answer: "Lien vers la page contact ou courriel."
  - question: "Ou trouver mon travail?"
    answer: "Lien vers le portfolio ou les projets."
```

**Step 2: Full build chain**

```bash
cd contracts && npm run build && cd ..
cd ralph && npm run build && cd ..
cd runner && npm run build && cd ..
cd engine && npm run build && cd ..
cd cli && npm run build && cd ..
```

**Step 3: Smoke test (dry run)**

```bash
# Ensure STUDIO_PROJECTS_DIR is set
export STUDIO_PROJECTS_DIR=/home/arianeguay/dev/src/studio-projects
mkdir -p $STUDIO_PROJECTS_DIR

# Run with input file — should clone repo and attempt pipeline
studio run feature-builder --input-file engine/inputs/faq-about.input.yaml
```

Expected: Clone succeeds, pipeline starts, first stage runs with structured input visible in the prompt.

**Step 4: Commit**

```bash
git add engine/inputs/faq-about.input.yaml
git commit -m "feat: add FAQ input file and complete repo clone + structured input"
```

---

## Summary of changes by repo

| Repo | Files changed | Nature |
|------|--------------|--------|
| contracts | `src/pipeline.ts`, `tests/types.test.ts` | Add `repo` field to type |
| engine | `src/engine.ts`, `src/pipeline/context-propagation.ts`, `tests/context-propagation.test.ts`, `tests/loader.test.ts`, `pipelines/feature-builder.pipeline.yaml` | Widen input type, parse repo field |
| cli | `src/index.ts`, `src/commands/run.ts`, `src/config.ts` | New options, clone logic, input file loading |
| runner | (no changes) | Prompt builder already handles `additional_context` as string |
| root | `.studiorc.yaml`, `.env.example` | Add `projects_dir` config |
