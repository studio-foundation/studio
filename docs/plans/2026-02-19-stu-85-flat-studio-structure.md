# STU-85: Remove projects/ Indirection in .studio/ Structure

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Flatten `.studio/` so pipelines, agents, contracts and tools live directly there — no more `projects/<name>/` layer. Change `studio run project/pipeline` to `studio run pipeline`.

**Architecture:** Seven coordinated changes across templates, validate command, engine, init, run, and list. Templates lose the `project/` subdir. Engine stops parsing `project/pipeline` identifiers. CLI commands point `configsDir` at `.studio/` directly instead of `.studio/projects/`.

**Tech Stack:** TypeScript, Vitest, Node.js fs/promises, YAML, pnpm workspaces. All work is in the worktree at `.worktrees/stu-85-flat-structure/`. Run all commands from that worktree root.

---

### Current state (read before touching anything)

- **Templates** live in `cli/templates/projects/<name>/`. Each template has a `project/` subdir that holds `pipelines/`, `agents/`, `contracts/`, `tools/`, `inputs/`. After STU-85, the `project/` level is gone — these dirs live directly under the template dir.
- **Engine** (`engine/src/engine.ts`): `parseProjectPipeline('software/feature-builder')` splits the identifier into `{ project: 'software', pipeline: 'feature-builder' }`. `resolveProjectPaths(configsDir, project)` builds the subdir paths. After STU-85, the identifier is just `'feature-builder'` and `configsDir` already points to the right flat dir.
- **`run.ts`** (`cli/src/commands/run.ts`): `configsDir = resolve(studioDir, 'projects')`. After STU-85: `configsDir = studioDir`.
- **`init.ts`** (`cli/src/commands/init.ts`): `createStudioStructure` creates `.studio/projects/<name>/pipelines/` etc. After STU-85: creates `.studio/pipelines/` etc. directly.
- **`project.ts`** (`cli/src/commands/project.ts`): `createProjectDir(projectsDir, name, template)` copies from `template/project/` into `projectsDir/<name>/`. After STU-85: copies from `template/` into `studioDir/` directly. The `studio project add` command loses meaning.
- **`list.ts`** (`cli/src/commands/list.ts`): loops over project subdirs to list pipelines as `project/pipeline`. After STU-85: reads `pipelines/` directly, no project prefix.
- **`run-logger.ts`**: log filename is `{date}-{project}-{pipeline}-{runId}.jsonl`. After STU-85: `{date}-{pipeline}-{runId}.jsonl`.
- **Engine tests**: `configsDir: FIXTURES_DIR`, `pipeline: 'test-project/simple'`. After STU-85: `configsDir: join(FIXTURES_DIR, 'test-project')`, `pipeline: 'simple'`.

---

### Task 1: Flatten template directories

**Files:**
- Move: `cli/templates/projects/software/project/*` → `cli/templates/projects/software/`
- Move: `cli/templates/projects/software-full/project/*` → `cli/templates/projects/software-full/`
- Move: `cli/templates/projects/content/project/*` → `cli/templates/projects/content/`
- Move: `cli/templates/projects/document-analysis/project/*` → `cli/templates/projects/document-analysis/`
- (blank template has no `project/` dir — skip)

No test changes yet — the validate tests still pass because the test templates reference `project/`. We'll fix that in Task 2.

**Step 1: Move software template**

```bash
cd .worktrees/stu-85-flat-structure
mv cli/templates/projects/software/project/* cli/templates/projects/software/
rmdir cli/templates/projects/software/project
```

**Step 2: Move software-full template**

```bash
mv cli/templates/projects/software-full/project/* cli/templates/projects/software-full/
rmdir cli/templates/projects/software-full/project
```

**Step 3: Move content template**

```bash
mv cli/templates/projects/content/project/* cli/templates/projects/content/
rmdir cli/templates/projects/content/project
```

**Step 4: Move document-analysis template**

```bash
mv cli/templates/projects/document-analysis/project/* cli/templates/projects/document-analysis/
rmdir cli/templates/projects/document-analysis/project
```

**Step 5: Verify structure**

```bash
find cli/templates/projects -maxdepth 3 -name "*.yaml" | sort
```

Expected: `cli/templates/projects/software/pipelines/feature-builder.pipeline.yaml` (no `project/` level), similarly for others.

**Step 6: Commit**

```bash
git add cli/templates/
git commit -m "refactor(templates): flatten project/ subdir — pipelines/ agents/ etc. now at template root (STU-85)"
```

---

### Task 2: Update `template/validate.ts` — remove `project/` subdir check

**Files:**
- Modify: `cli/src/commands/template/validate.ts`
- Modify: `cli/tests/commands/template/validate.test.ts`

**Step 1: Write failing tests**

Open `cli/tests/commands/template/validate.test.ts`. Find the test that checks for `project/ directory not found`. Update it to expect NO `project/` requirement. Also find any test that constructs a mock template with `project/` subdirs and update it to use the flat structure.

The current test (read the file to confirm) creates a mock template with:
```
tmpDir/
  metadata.json
  project/
    pipelines/  ← 2 pipeline files
    agents/     ← 1 agent file
    contracts/
```

Update the helper that creates mock templates to use the flat structure:
```
tmpDir/
  metadata.json
  pipelines/  ← 2 pipeline files
  agents/     ← 1 agent file
  contracts/
```

The error message `'project/ directory not found'` should no longer appear. Instead, `'pipelines/: found 0 pipeline(s)'` etc.

Exact test to update — find the test that passes a dir without `project/` and expects `'project/ directory not found'`. After the change, that test should instead pass a dir without `pipelines/` and expect a different error about pipelines.

**Step 2: Run to verify failure**

```bash
pnpm --filter @studio-foundation/cli test 2>&1 | grep -A3 'validate'
```

Expected: tests fail because the code still checks for `project/`.

**Step 3: Update `validate.ts`**

Find and replace the `project/` dir lookup section (around line 83–108):

```typescript
// BEFORE
const projectDir = join(templatePath, 'project');
if (!(await pathExists(projectDir))) {
  structuralErrors.push('project/ directory not found');
  return { valid: false, structuralErrors, semanticErrors: [], warnings };
}

const pipelinesDir = join(projectDir, 'pipelines');
const pipelineFiles = (await listYamlFiles(pipelinesDir)).filter((f) => f.endsWith('.pipeline.yaml'));
if (pipelineFiles.length < 2) {
  structuralErrors.push(`project/pipelines/: found ${pipelineFiles.length} pipeline(s), need at least 2`);
}

const agentsDir = join(projectDir, 'agents');
const agentFiles = (await listYamlFiles(agentsDir)).filter((f) => f.endsWith('.agent.yaml'));
if (agentFiles.length < 1) {
  structuralErrors.push('project/agents/: no .agent.yaml files found (need at least 1)');
}

const contractsDir = join(projectDir, 'contracts');
if (!(await pathExists(contractsDir))) {
  structuralErrors.push('project/contracts/ directory not found');
}
```

Replace with:

```typescript
// AFTER
const pipelinesDir = join(templatePath, 'pipelines');
const pipelineFiles = (await listYamlFiles(pipelinesDir)).filter((f) => f.endsWith('.pipeline.yaml'));
if (pipelineFiles.length < 2) {
  structuralErrors.push(`pipelines/: found ${pipelineFiles.length} pipeline(s), need at least 2`);
}

const agentsDir = join(templatePath, 'agents');
const agentFiles = (await listYamlFiles(agentsDir)).filter((f) => f.endsWith('.agent.yaml'));
if (agentFiles.length < 1) {
  structuralErrors.push('agents/: no .agent.yaml files found (need at least 1)');
}

const contractsDir = join(templatePath, 'contracts');
if (!(await pathExists(contractsDir))) {
  structuralErrors.push('contracts/ directory not found');
}
```

Also update the semantic section below that references `projectDir`:

```typescript
// BEFORE
const allYamlDirs: [string, string][] = [
  [pipelinesDir, 'pipelines'],
  [agentsDir, 'agents'],
  [contractsDir, 'contracts'],
  [join(projectDir, 'tools'), 'tools'],
];
```

Replace with:

```typescript
// AFTER
const allYamlDirs: [string, string][] = [
  [pipelinesDir, 'pipelines'],
  [agentsDir, 'agents'],
  [contractsDir, 'contracts'],
  [join(templatePath, 'tools'), 'tools'],
];
```

**Step 4: Build and run tests**

```bash
pnpm build && pnpm --filter @studio-foundation/cli test -- --reporter=verbose 2>&1 | grep -E '(validate|✓|✗|PASS|FAIL)'
```

Expected: all validate tests pass.

**Step 5: Commit**

```bash
git add cli/src/commands/template/validate.ts cli/tests/commands/template/validate.test.ts
git commit -m "refactor(cli): update template validate to flat structure — no project/ subdir (STU-85)"
```

---

### Task 3: Update engine — remove project/pipeline parsing

The engine currently parses `'test-project/simple'` into `{ project, pipeline }` and uses `project` to find subdirs. After this task, it accepts `'simple'` directly and uses `configsDir` as the project root.

**Files:**
- Modify: `engine/src/engine.ts`
- Modify: `engine/src/index.ts` (remove `parseProjectPipeline` export)
- Modify: `engine/tests/engine.test.ts`
- Modify: `engine/tests/group-loop.test.ts`

**Step 1: Update engine tests to expect the new behavior (failing)**

In `engine/tests/engine.test.ts`:
- Change `configsDir: FIXTURES_DIR` → `configsDir: join(FIXTURES_DIR, 'test-project')`
- Change every `pipeline: 'test-project/simple'` → `pipeline: 'simple'`
- Change every `pipeline: 'test-project/two-stage'` → `pipeline: 'two-stage'`

Exact diff for the `createTestEngine` function and all `engine.run()` calls:

```typescript
// engine/tests/engine.test.ts

// At the top, add (or update existing):
const PROJECT_DIR = join(FIXTURES_DIR, 'test-project');

function createTestEngine(overrides: Partial<EngineConfig> = {}): PipelineEngine {
  return new PipelineEngine({
    configsDir: PROJECT_DIR,    // ← was FIXTURES_DIR
    providerRegistry: createMockProviderRegistry() as any,
    toolRegistry: createMockToolRegistry() as any,
    db: new InMemoryRunStore(),
    ...overrides,
  });
}
```

Replace all `pipeline: 'test-project/simple'` with `pipeline: 'simple'`, and `pipeline: 'test-project/two-stage'` with `pipeline: 'two-stage'`.

In the `'emits lifecycle events'` test, update too:
```typescript
const engine = new PipelineEngine(
  {
    configsDir: PROJECT_DIR,    // ← was FIXTURES_DIR
    ...
  },
  engineEvents
);
await engine.run({ pipeline: 'simple', input: 'test events' });  // ← was 'test-project/simple'
```

In `engine/tests/group-loop.test.ts`:
- Update `configsDir: FIXTURES_DIR` → `configsDir: PROJECT_DIR` (need to declare `PROJECT_DIR = join(FIXTURES_DIR, 'test-project')`)
- Replace every `pipeline: 'test-project/group-test'` → `pipeline: 'group-test'`

**Step 2: Run to verify failure**

```bash
pnpm --filter @studio-foundation/engine test 2>&1 | tail -20
```

Expected: tests fail with "Invalid pipeline identifier 'simple'" or similar.

**Step 3: Update `engine.ts`**

**3a. Remove `parseProjectPipeline` and update `resolveProjectPaths`:**

```typescript
// REMOVE entirely:
export function parseProjectPipeline(identifier: string): { project: string; pipeline: string } {
  const parts = identifier.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid pipeline identifier '${identifier}'. Expected format: project/pipeline (e.g. 'software/feature-builder')`
    );
  }
  return { project: parts[0], pipeline: parts[1] };
}

// UPDATE resolveProjectPaths — remove the project parameter:
// BEFORE:
function resolveProjectPaths(configsDir: string, project: string): ProjectPaths {
  const projectDir = join(configsDir, project);
  return {
    projectDir,
    pipelinesDir: join(projectDir, 'pipelines'),
    agentsDir: join(projectDir, 'agents'),
    contractsDir: join(projectDir, 'contracts'),
  };
}

// AFTER:
function resolveProjectPaths(configsDir: string): ProjectPaths {
  return {
    projectDir: configsDir,
    pipelinesDir: join(configsDir, 'pipelines'),
    agentsDir: join(configsDir, 'agents'),
    contractsDir: join(configsDir, 'contracts'),
  };
}
```

**3b. Update `run()` to not parse project from the identifier:**

```typescript
// BEFORE:
async run(input: RunInput): Promise<PipelineRun> {
  // 1. Parse project/pipeline identifier and resolve paths
  const { project, pipeline: pipelineName } = parseProjectPipeline(input.pipeline);
  const projectPaths = resolveProjectPaths(this.config.configsDir, project);

// AFTER:
async run(input: RunInput): Promise<PipelineRun> {
  // 1. Resolve paths — configsDir IS the project root
  const pipelineName = input.pipeline;
  const projectPaths = resolveProjectPaths(this.config.configsDir);
```

**3c. Fix the keymap path comment (line ~796):**

```typescript
// BEFORE:
// configsDir is .studio/projects/ — keymap goes in .studio/runs/anonymization/
const anonDir = join(this.config.configsDir, '..', 'runs', 'anonymization');

// AFTER:
// configsDir is .studio/ — keymap goes in .studio/runs/anonymization/
const anonDir = join(this.config.configsDir, 'runs', 'anonymization');
```

**Step 4: Remove `parseProjectPipeline` from `engine/src/index.ts`**

```typescript
// BEFORE:
export { PipelineEngine, parseProjectPipeline } from './engine.js';

// AFTER:
export { PipelineEngine } from './engine.js';
```

Also remove `loadPipelineByName` if it's re-exported from index.ts for use in run.ts — check `engine/src/index.ts` first. If `loadPipelineByName` is exported there, keep it.

**Step 5: Build and run engine tests**

```bash
pnpm build && pnpm --filter @studio-foundation/engine test 2>&1 | tail -20
```

Expected: all engine tests pass (simple, two-stage, group-loop, etc.).

**Step 6: Commit**

```bash
git add engine/src/engine.ts engine/src/index.ts engine/tests/engine.test.ts engine/tests/group-loop.test.ts
git commit -m "refactor(engine): remove project/pipeline parsing — configsDir is now the project root (STU-85)"
```

---

### Task 4: Update `init.ts` + `project.ts` — flat `.studio/` structure

**Files:**
- Modify: `cli/src/commands/init.ts`
- Modify: `cli/src/commands/project.ts`
- Modify: `cli/tests/commands/init.test.ts`
- Modify: `cli/tests/commands/project.test.ts`

**Step 1: Update init tests to expect flat structure (failing)**

In `cli/tests/commands/init.test.ts`:

Find the `createStudioStructure` describe block. Every assertion that checks `projects/<name>/` paths must be updated to check flat paths.

```typescript
// BEFORE:
expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'pipelines'))).toBe(true);
expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'agents'))).toBe(true);
expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'contracts'))).toBe(true);
expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'tools'))).toBe(true);
expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'inputs'))).toBe(true);

// AFTER:
expect(await exists(resolve(TMP, '.studio', 'pipelines'))).toBe(true);
expect(await exists(resolve(TMP, '.studio', 'agents'))).toBe(true);
expect(await exists(resolve(TMP, '.studio', 'contracts'))).toBe(true);
expect(await exists(resolve(TMP, '.studio', 'tools'))).toBe(true);
expect(await exists(resolve(TMP, '.studio', 'inputs'))).toBe(true);
```

Also update the test that checks template files are copied:
```typescript
// BEFORE:
expect(await exists(resolve(TMP, '.studio', 'projects', 'software', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);

// AFTER:
expect(await exists(resolve(TMP, '.studio', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);
```

Remove any test that references `projects/` in the path. Search for all occurrences of `'projects'` in `init.test.ts` and update them.

For `project.test.ts`: The `createProjectDir` function is being removed/repurposed. Delete or skip the entire `createProjectDir` describe block. (The function no longer has a meaningful role in the flat structure.) Add a new describe block that tests the new `copyTemplateToStudio` behavior (from Task 4 Step 3).

**Step 2: Run to verify failure**

```bash
pnpm --filter @studio-foundation/cli test 2>&1 | grep -E '(init|project|FAIL|✗)'
```

Expected: init tests fail because `.studio/projects/default/pipelines` doesn't exist.

**Step 3: Update `createStudioStructure` in `init.ts`**

```typescript
// BEFORE:
export async function createStudioStructure(
  cwd: string,
  projectName = 'default',
  templateName?: string,
  withTools = true
): Promise<void> {
  const existing = await findStudioDir(cwd);
  if (existing) { throw new Error(...); }

  const studioDir = resolve(cwd, '.studio');
  const projectsDir = join(studioDir, 'projects');
  await mkdir(projectsDir, { recursive: true });
  await createProjectDir(projectsDir, projectName, templateName, { withTools });

  await mkdir(join(studioDir, 'runs', 'logs'), { recursive: true });
  await writeFile(join(studioDir, 'registry.lock.json'), '{}\n', 'utf-8');
  // ... config + gitignore
}
```

```typescript
// AFTER (projectName param is removed since there's no project subdir):
export async function createStudioStructure(
  cwd: string,
  templateName?: string,
  withTools = true
): Promise<void> {
  const existing = await findStudioDir(cwd);
  if (existing) { throw new Error(...); }

  const studioDir = resolve(cwd, '.studio');
  await copyTemplateToStudio(studioDir, templateName, { withTools });

  await mkdir(join(studioDir, 'runs', 'logs'), { recursive: true });
  await writeFile(join(studioDir, 'registry.lock.json'), '{}\n', 'utf-8');

  const configPath = join(studioDir, 'config.yaml');
  const configExists = await access(configPath).then(() => true).catch(() => false);
  if (!configExists) {
    const template = await readFile(resolve(TEMPLATES_DIR, 'studio-config.yaml'), 'utf-8');
    await writeFile(configPath, template, 'utf-8');
  }

  await updateGitignore(cwd);
}
```

**Step 4: Add `copyTemplateToStudio` to `init.ts`** (or keep in `project.ts`)

Add this new function to `cli/src/commands/init.ts`:

```typescript
const STUDIO_SUBDIRS = ['pipelines', 'agents', 'contracts', 'tools', 'inputs'];

/**
 * Create or populate .studio/ with subdirs.
 * If templateName is provided, copies content from the template root (flat — no project/ subdir).
 * If withTools is false, creates an empty tools/ dir instead of copying from template.
 */
async function copyTemplateToStudio(
  studioDir: string,
  templateName?: string,
  options: { withTools?: boolean } = {}
): Promise<void> {
  const withTools = options.withTools ?? true;

  if (templateName) {
    const templateDir = resolve(TEMPLATES_DIR, 'projects', templateName);
    const templateExists = await access(templateDir).then(() => true).catch(() => false);
    if (!templateExists) {
      throw new Error(
        `Template '${templateName}' not found. Run 'studio templates list' to see available templates.`
      );
    }

    await mkdir(studioDir, { recursive: true });

    if (withTools) {
      await cp(templateDir, studioDir, {
        recursive: true,
        filter: (src) => !src.endsWith('metadata.json'),
      });
    } else {
      await cp(templateDir, studioDir, {
        recursive: true,
        filter: (src) => {
          const rel = relative(templateDir, src);
          return !rel.endsWith('metadata.json') && rel !== 'tools' && !rel.startsWith('tools' + sep);
        },
      });
      await mkdir(join(studioDir, 'tools'), { recursive: true });
    }
  } else {
    for (const sub of STUDIO_SUBDIRS) {
      await mkdir(join(studioDir, sub), { recursive: true });
    }
  }
}
```

Add imports: `cp` from `node:fs/promises`, `relative` from `node:path`, `sep` from `node:path` (if not already imported).

**Step 5: Update callers of `createStudioStructure` in `init.ts`**

The function now has signature `(cwd, templateName?, withTools?)` — the `projectName` param is removed.

Update the `directInit` function:
```typescript
// BEFORE:
export async function directInit(
  cwd: string,
  projectName: string,
  templateName: string,
  provider: string,
  apiKey: string,
  noTools = false
): Promise<void> {
  await createStudioStructure(cwd, projectName, templateName, !noTools);
  ...
}

// AFTER:
export async function directInit(
  cwd: string,
  templateName: string,
  provider: string,
  apiKey: string,
  noTools = false
): Promise<void> {
  await createStudioStructure(cwd, templateName, !noTools);
  ...
}
```

Update `initCommand` (direct mode):
```typescript
// BEFORE:
await directInit(cwd, projectName, options.template!, options.provider!, options.apiKey ?? '', options.tools === false);

// Update messages:
console.log(chalk.green(`  ✓ .studio/projects/${projectName}/`));
// and:
console.log(`  ${chalk.cyan(`studio run ${projectName}/${firstPipeline} --input "..."`)}`);

// AFTER:
await directInit(cwd, options.template!, options.provider!, options.apiKey ?? '', options.tools === false);

// Update messages:
console.log(chalk.green(`  ✓ .studio/pipelines/`));
// and:
console.log(`  ${chalk.cyan(`studio run ${firstPipeline} --input "..."`)}`);
```

Update `initCommand` (wizard mode, Step 7):
```typescript
// BEFORE:
await createStudioStructure(cwd, projectName, templateName, false);

// Update messages:
console.log(chalk.green(`  ✓ .studio/projects/${projectName}/`));
// and:
console.log(`  ${chalk.cyan(`studio run ${projectName}/${firstPipeline} --input "..."`)}`);

// AFTER:
await createStudioStructure(cwd, templateName, false);

// Update messages:
console.log(chalk.green(`  ✓ .studio/pipelines/`));
// and:
console.log(`  ${chalk.cyan(`studio run ${firstPipeline} --input "..."`)}`);
```

**Step 6: Update `project.ts`**

`createProjectDir`, `projectAddDirect`, and `projectAddWizard` all assume the `projects/<name>` structure. After STU-85, `studio project add` doesn't make sense. Update `projectCommand` to show a clear error:

```typescript
export async function projectCommand(
  action: string,
  _args: string[],
  _options: { template?: string; description?: string }
): Promise<void> {
  console.error(
    chalk.red('  ✗ `studio project add` is no longer supported.')
  );
  console.log('');
  console.log('Each workspace now has one flat .studio/ structure.');
  console.log(`To start a new project, create a new directory and run ${chalk.cyan('studio init')}.`);
  console.log('');
  process.exit(1);
}
```

Keep `createProjectDir` and `PROJECT_SUBDIRS` as exported (they may be used in tests), but mark them as deprecated internally. The key is to not break existing callers.

Actually — if `createProjectDir` is called from `projectAddDirect` which is called from `projectCommand`, and we're replacing `projectCommand`, then we can leave `createProjectDir` unchanged (the tests can update separately).

**Step 7: Update `project.test.ts`**

Since `studio project add` is now unsupported, skip or remove `createProjectDir` tests, OR update them to test that the command returns an error. This is your call — for simplicity, add `.skip` to the whole `createProjectDir` describe block and add a new test for the error behavior.

**Step 8: Build and run tests**

```bash
pnpm build && pnpm --filter @studio-foundation/cli test 2>&1 | tail -30
```

Expected: init tests pass, project tests pass (or skipped).

**Step 9: Commit**

```bash
git add cli/src/commands/init.ts cli/src/commands/project.ts cli/tests/commands/init.test.ts cli/tests/commands/project.test.ts
git commit -m "refactor(cli): flatten .studio/ — no projects/ layer in init + project commands (STU-85)"
```

---

### Task 5: Update `run.ts` + `run-logger.ts` — flat configsDir

**Files:**
- Modify: `cli/src/commands/run.ts`
- Modify: `cli/src/run-logger.ts`

No existing tests to update (`run.test.ts` is all skipped).

**Step 1: Update `run-logger.ts` — remove project from filename**

```typescript
// BEFORE:
export interface RunLogger {
  start(runId: string, pipeline: string, project: string): void;
  ...
}

// In start():
logPath = resolve(base, `${date}-${project}-${pipeline}-${shortRunId}.jsonl`);

// AFTER:
export interface RunLogger {
  start(runId: string, pipeline: string): void;  // project removed
  ...
}

// In start():
logPath = resolve(base, `${date}-${pipeline}-${shortRunId}.jsonl`);
```

**Step 2: Update `run.ts`**

**2a. Update `configsDir` computation:**

```typescript
// BEFORE:
const configsDir = config.paths?.configs
  ? resolve(config.paths.configs)
  : config.resolvedStudioDir
    ? resolve(config.resolvedStudioDir, 'projects')
    : resolve('./configs');
const { project, pipeline: pipelineBase } = parseProjectPipeline(pipelineName);
const pipelinesDir = join(configsDir, project, 'pipelines');

// AFTER:
const configsDir = config.paths?.configs
  ? resolve(config.paths.configs)
  : config.resolvedStudioDir
    ? resolve(config.resolvedStudioDir)
    : resolve('./configs');
// pipelineName is now just the pipeline name (no project prefix)
const pipelinesDir = join(configsDir, 'pipelines');
```

**2b. Update the early `loadPipelineByName` call (needed for input_schema):**

```typescript
// BEFORE:
const pipelinesDir = join(configsDir, project, 'pipelines');
const pipelineDef = await loadPipelineByName(pipelineBase, pipelinesDir);

// AFTER (pipelinesDir already computed above):
const pipelineDef = await loadPipelineByName(pipelineName, pipelinesDir);
```

**2c. Update mock provider path:**

```typescript
// BEFORE:
const mockYamlPath = join(configsDir, project, 'mock.yaml');

// AFTER:
const mockYamlPath = join(configsDir, 'mock.yaml');
```

**2d. Update tools path:**

```typescript
// BEFORE:
const toolsDir = resolve(configsDir, project, 'tools');

// AFTER:
const toolsDir = resolve(configsDir, 'tools');
```

**2e. Update `mergeEvents` call — remove project argument:**

The `mergeEvents` function signature has `project: string`. Remove it:

```typescript
// BEFORE:
function mergeEvents(
  progressEvents: EngineEvents,
  logger: ReturnType<typeof createRunLogger>,
  project: string,
  pipeline: string,
  input: ...
): EngineEvents {
  ...
  onPipelineStart: (e) => {
    logger.start(e.run_id, pipeline, project);
    logger.log({ event: 'pipeline_start', ..., project, pipeline, ... });
  },
  ...
}
// Called as:
const events = mergeEvents(progress.getEvents(), runLogger, project, pipelineBase, input);

// AFTER:
function mergeEvents(
  progressEvents: EngineEvents,
  logger: ReturnType<typeof createRunLogger>,
  pipeline: string,
  input: ...
): EngineEvents {
  ...
  onPipelineStart: (e) => {
    logger.start(e.run_id, pipeline);   // project removed
    logger.log({ event: 'pipeline_start', ..., pipeline, ... });   // project removed
  },
  ...
}
// Called as:
const events = mergeEvents(progress.getEvents(), runLogger, pipelineName, input);
```

**2f. Remove `parseProjectPipeline` import:**

```typescript
// BEFORE:
import { PipelineEngine, parseProjectPipeline, loadPipelineByName } from '@studio-foundation/engine';

// AFTER:
import { PipelineEngine, loadPipelineByName } from '@studio-foundation/engine';
```

**2g. Update engine `run()` call:**

```typescript
// BEFORE:
result = await engine.run({
  pipeline: pipelineName,  // was 'project/pipeline'
  ...
});

// AFTER: pipelineName is already just 'pipeline' — no change to this call
// But engine.configsDir now points to studioDir:
const engine = new PipelineEngine(
  {
    configsDir,          // now .studio/ directly
    repoPath,
    providerRegistry,
    toolRegistry,
    ...
  },
  events
);
```

**Step 3: Build and manual smoke-test**

```bash
pnpm build
```

Expected: builds cleanly with no TypeScript errors.

There are no automated run.ts tests — rely on the integration test in Task 7.

**Step 4: Commit**

```bash
git add cli/src/commands/run.ts cli/src/run-logger.ts
git commit -m "refactor(cli): update run command to flat configsDir — no project prefix in pipeline name (STU-85)"
```

---

### Task 6: Update `list.ts` — flat listing

**Files:**
- Modify: `cli/src/commands/list.ts`

No list tests exist. Update the code and rely on the smoke test.

**Step 1: Update `configsDir` computation**

```typescript
// BEFORE:
const configsDir = config.paths?.configs
  ? resolve(config.paths.configs)
  : config.resolvedStudioDir
    ? resolve(config.resolvedStudioDir, 'projects')
    : resolve('./configs');

// AFTER:
const configsDir = config.paths?.configs
  ? resolve(config.paths.configs)
  : config.resolvedStudioDir
    ? resolve(config.resolvedStudioDir)
    : resolve('./configs');
```

**Step 2: Update `listPipelines`**

```typescript
// BEFORE:
async function listPipelines(configsDir: string, json?: boolean): Promise<void> {
  const projects = await getProjects(configsDir);
  const results: string[] = [];

  for (const project of projects) {
    const pipelinesDir = join(configsDir, project, 'pipelines');
    const names = await getFileNames(pipelinesDir, '.pipeline.yaml');
    for (const name of names) {
      results.push(`${project}/${name}`);
    }
  }
  ...
  console.log(`  - ${name}`);  // was 'project/name'
}

// AFTER:
async function listPipelines(configsDir: string, json?: boolean): Promise<void> {
  const pipelinesDir = join(configsDir, 'pipelines');
  const results = await getFileNames(pipelinesDir, '.pipeline.yaml');

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(chalk.yellow('No pipelines found'));
    return;
  }

  console.log('\nPipelines:');
  for (const name of results) {
    console.log(`  - ${name}`);
  }
  console.log('');
}
```

**Step 3: Update `listAgents`**

```typescript
// BEFORE:
async function listAgents(configsDir: string, json?: boolean): Promise<void> {
  const projects = await getProjects(configsDir);
  const results: string[] = [];
  for (const project of projects) {
    const agentsDir = join(configsDir, project, 'agents');
    const names = await getFileNames(agentsDir, '.agent.yaml');
    for (const name of names) {
      results.push(`${project}/${name}`);
    }
  }
  ...
}

// AFTER:
async function listAgents(configsDir: string, json?: boolean): Promise<void> {
  const agentsDir = join(configsDir, 'agents');
  const results = await getFileNames(agentsDir, '.agent.yaml');

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(chalk.yellow('No agents found'));
    return;
  }

  console.log('\nAgents:');
  for (const name of results) {
    console.log(`  - ${name}`);
  }
  console.log('');
}
```

**Step 4: Update `listProjects`**

`studio list projects` no longer makes sense (there IS only one workspace). Update it to print a helpful message:

```typescript
async function listProjects(configsDir: string, json?: boolean): Promise<void> {
  // With the flat .studio/ structure, there is no projects/ layer.
  // The workspace itself IS the project.
  if (json) {
    console.log(JSON.stringify([configsDir], null, 2));
    return;
  }
  console.log('\nThis workspace uses a flat .studio/ structure (no projects/ layer).');
  console.log('Run `studio list pipelines` to see available pipelines.');
  console.log('');
}
```

**Step 5: Update `listRuns` filename parsing**

The log filename changed from `{date}-{project}-{pipeline}-{runId}.jsonl` to `{date}-{pipeline}-{runId}.jsonl`.

```typescript
// BEFORE (in listRuns):
const match = filename.match(/^(\d{4}-\d{2}-\d{2}T\d{1,2}h\d{1,2}m)-(.+)-([a-f0-9]{8})\.jsonl$/i);
if (!match) continue;
const datePart = match[1];
const middle = match[2];
const runId = match[3];
const lastHyphen = middle.lastIndexOf('-');
if (lastHyphen <= 0) continue;
const project = middle.slice(0, lastHyphen);
const pipeline = middle.slice(lastHyphen + 1);

// AFTER:
const match = filename.match(/^(\d{4}-\d{2}-\d{2}T\d{1,2}h\d{1,2}m)-(.+)-([a-f0-9]{8})\.jsonl$/i);
if (!match) continue;
const datePart = match[1];
const pipeline = match[2];    // entire middle is the pipeline name
const runId = match[3];
```

Also update `RunListEntry` to drop `project`:
```typescript
// BEFORE:
interface RunListEntry {
  date: string;
  project: string;
  pipeline: string;
  run_id: string;
  status: string;
  filename: string;
}

// AFTER:
interface RunListEntry {
  date: string;
  pipeline: string;
  run_id: string;
  status: string;
  filename: string;
}
```

And update the `runs.push()` call and the display:
```typescript
// BEFORE:
runs.push({ date: datePart ?? filename, project, pipeline, run_id: runId ?? '', status, filename });
// display:
console.log(`  ${r.date}  ${r.project}/${r.pipeline}  ${r.run_id}  ${statusColor(r.status)}`);

// AFTER:
runs.push({ date: datePart ?? filename, pipeline, run_id: runId ?? '', status, filename });
// display:
console.log(`  ${r.date}  ${r.pipeline}  ${r.run_id}  ${statusColor(r.status)}`);
```

Also remove the `options.project` filter since there's no project prefix:
```typescript
// REMOVE this filter line:
if (options.project && project !== options.project) continue;
```

**Step 6: Remove `getProjects` function** (no longer used after removing project loops from listPipelines and listAgents):

Delete the `getProjects` function entirely from `list.ts`.

**Step 7: Build**

```bash
pnpm build 2>&1
```

Expected: clean TypeScript build, no errors.

**Step 8: Commit**

```bash
git add cli/src/commands/list.ts
git commit -m "refactor(cli): update list command to flat structure — no project prefix in output (STU-85)"
```

---

### Task 7: Final verification

**Step 1: Run full test suite**

```bash
pnpm test 2>&1 | tail -30
```

Expected: all tests pass across all packages. Zero failures. If skipped tests count increases, that's from `project.test.ts` — acceptable.

**Step 2: Build check**

```bash
pnpm build 2>&1
```

Expected: exits 0, no TypeScript errors.

**Step 3: Smoke test — init + list + run**

```bash
# Create test workspace
cd /tmp && mkdir -p studio-stu85-test && cd studio-stu85-test

# Init with flat structure
node /home/arianeguay/dev/src/Studio/.worktrees/stu-85-flat-structure/cli/dist/index.js init \
  --template software \
  --provider later \
  --yes

# Verify flat structure (NO projects/ layer)
ls .studio/
# Expected: config.yaml  pipelines/  agents/  contracts/  tools/  inputs/  runs/  registry.lock.json
# NOT: projects/

ls .studio/pipelines/
# Expected: feature-builder.pipeline.yaml

# List (no project prefix)
node /home/arianeguay/dev/src/Studio/.worktrees/stu-85-flat-structure/cli/dist/index.js list pipelines
# Expected: "  - feature-builder"  (not "software/feature-builder")

# Cleanup
cd /tmp && rm -rf studio-stu85-test
```

**Step 4: Verify acceptance criteria from STU-85**

- [ ] Loaders use flat structure (no `projects/<name>/`)
- [ ] `studio run feature-builder` works (no project prefix)
- [ ] `studio list pipelines` output has no project prefix
- [ ] All templates flattened (no `project/` subdir)
- [ ] `template validate` works on flat template structure
- [ ] CLAUDE.md references updated

**Step 5: Update CLAUDE.md**

Search for all `projects/<name>` references in `CLAUDE.md` and `TEMPLATES.md`. Update the structure diagrams:

In `CLAUDE.md`, the `.studio/` structure section currently shows:
```
.studio/
├── config.yaml
├── projects/
│   └── <project>/
│       ├── pipelines/
│       ├── agents/
│       ├── contracts/
│       ├── tools/
│       └── inputs/
├── registry.lock.json
└── runs/
```

Update to:
```
.studio/
├── config.yaml
├── pipelines/
├── agents/
├── contracts/
├── tools/
├── inputs/
├── registry.lock.json
└── runs/
```

Also update every `studio run project/pipeline` example to `studio run pipeline`.

**Step 6: Run tests one more time after CLAUDE.md changes**

```bash
pnpm test 2>&1 | tail -10
```

Expected: all tests still pass.

**Step 7: Final commit**

```bash
git add CLAUDE.md TEMPLATES.md
git commit -m "docs: update CLAUDE.md and TEMPLATES.md to reflect flat .studio/ structure (STU-85)"
```

---

### Notes for executor

- **Build after EVERY code change**: `pnpm build` from the worktree root. TypeScript won't catch runtime path issues but will catch type errors from changed signatures.
- **`cp` import**: In `init.ts`, `cp` from `node:fs/promises` may not be imported yet. Add: `import { mkdir, writeFile, readFile, access, rename, cp } from 'node:fs/promises';` and `import { relative, sep } from 'node:path';`
- **`parseProjectPipeline` is re-exported**: Removing from `engine/src/index.ts` is required. `run.ts` currently imports it — remove that import too.
- **Engine tests `FIXTURES_DIR`**: The fixture structure already has `test-project/pipelines/`, `test-project/agents/`, `test-project/contracts/` — the tests just need to point `configsDir` at `FIXTURES_DIR/test-project/` instead of `FIXTURES_DIR/`.
- **`metadata.json` in templates**: The `cp` call filters out `metadata.json` to avoid copying it into `.studio/`. Only the pipeline/agent/contract/tool/input dirs should be copied.
- **`software-full` template**: Has the full `feature-builder` pipeline with groups. Ensure it's flattened correctly in Task 1.
- **`context-pack-loader.ts`**: Takes `projectConfigPath` (= `paths.projectDir`). After the change, `paths.projectDir = configsDir` (the `.studio/` dir itself). Context packs will be at `.studio/context-packs/`. No code change needed in context-pack-loader — it already uses the `projectDir` that's passed in.
- **Don't update `contracts` package**: No changes needed there. Only `engine`, `cli`, and `runner` (via `loadProjectTools` path arg) are affected.
