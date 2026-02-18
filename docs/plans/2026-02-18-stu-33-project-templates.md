# Project Templates / Starters (STU-33) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship 4 built-in project templates (blank, software, content, document-analysis) that users install via `studio init --template <name>`, and a `studio templates list` command to discover them.

**Architecture:** Templates live as plain directories in `cli/templates/projects/<name>/`. Each has `metadata.json` and optionally a `project/` subdir that is recursively copied into `.studio/projects/<projectName>/` at init time. A new `templatesCommand` in `cli/src/commands/templates.ts` handles `studio templates list`.

**Tech Stack:** TypeScript, `node:fs/promises` (`cp` for recursive copy, already used in `init.ts`), chalk (already in cli).

**Working directory for all commands:** repo root (`/home/arianeguay/dev/src/Studio/`)

---

## Task 1 — Template data files (YAML + JSON, no code changes)

**Files to create:**
- `cli/templates/projects/blank/metadata.json`
- `cli/templates/projects/software/metadata.json`
- `cli/templates/projects/software/project/pipelines/feature-builder.pipeline.yaml`
- `cli/templates/projects/software/project/agents/coder.agent.yaml`
- `cli/templates/projects/software/project/contracts/code-output.contract.yaml`
- `cli/templates/projects/software/project/tools/repo-manager.tool.yaml`
- `cli/templates/projects/software/project/tools/search.tool.yaml`
- `cli/templates/projects/software/project/tools/shell.tool.yaml`
- `cli/templates/projects/software/project/inputs/example.input.yaml`
- `cli/templates/projects/content/metadata.json`
- `cli/templates/projects/content/project/pipelines/content-creator.pipeline.yaml`
- `cli/templates/projects/content/project/agents/writer.agent.yaml`
- `cli/templates/projects/content/project/contracts/content-output.contract.yaml`
- `cli/templates/projects/content/project/tools/search.tool.yaml`
- `cli/templates/projects/content/project/inputs/example.input.yaml`
- `cli/templates/projects/document-analysis/metadata.json`
- `cli/templates/projects/document-analysis/project/pipelines/analyzer.pipeline.yaml`
- `cli/templates/projects/document-analysis/project/agents/analyst.agent.yaml`
- `cli/templates/projects/document-analysis/project/contracts/analysis-output.contract.yaml`
- `cli/templates/projects/document-analysis/project/tools/search.tool.yaml`
- `cli/templates/projects/document-analysis/project/inputs/example.input.yaml`

**File to delete:**
- `cli/templates/pipelines/hello-world.pipeline.yaml` (superseded)

No tests needed for data files. Build verifies YAML validity indirectly (loader parses them at runtime).

---

### Step 1.1: Create blank template

```bash
mkdir -p cli/templates/projects/blank
```

`cli/templates/projects/blank/metadata.json`:
```json
{
  "name": "blank",
  "version": "1.0.0",
  "description": "Empty project structure",
  "type": "template",
  "studio_version": ">=7.0.0"
}
```

---

### Step 1.2: Create software template — directories

```bash
mkdir -p cli/templates/projects/software/project/{pipelines,agents,contracts,tools,inputs}
```

`cli/templates/projects/software/metadata.json`:
```json
{
  "name": "software",
  "version": "1.0.0",
  "description": "Code generation with repo, shell and search tools",
  "author": "studio-core",
  "tags": ["software", "code", "development"],
  "type": "template",
  "studio_version": ">=7.0.0",
  "pipelines": ["feature-builder"],
  "tools_included": ["repo-manager", "search", "shell"]
}
```

`cli/templates/projects/software/project/pipelines/feature-builder.pipeline.yaml`:
```yaml
name: feature-builder
description: Analyze a request and generate code changes
version: 1

stages:
  - name: code-generation
    kind: code
    agent: coder
    ralph:
      max_attempts: 3
    context:
      include:
        - input
```

`cli/templates/projects/software/project/agents/coder.agent.yaml`:
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

`cli/templates/projects/software/project/contracts/code-output.contract.yaml`:
```yaml
name: code-output
version: 1
schema:
  required_fields:
    - summary
    - files_changed
tool_calls:
  minimum: 1
```

Copy the 3 tool yamls from `cli/templates/tools/` into `cli/templates/projects/software/project/tools/`:

```bash
cp cli/templates/tools/repo-manager.tool.yaml cli/templates/projects/software/project/tools/
cp cli/templates/tools/search.tool.yaml cli/templates/projects/software/project/tools/
cp cli/templates/tools/shell.tool.yaml cli/templates/projects/software/project/tools/
```

`cli/templates/projects/software/project/inputs/example.input.yaml`:
```yaml
brief_summary: "Add a hello world function to src/utils.ts"
target_file: "src/utils.ts"
acceptance_criteria:
  - "Function is exported and returns 'Hello, World!'"
```

---

### Step 1.3: Create content template

```bash
mkdir -p cli/templates/projects/content/project/{pipelines,agents,contracts,tools,inputs}
```

`cli/templates/projects/content/metadata.json`:
```json
{
  "name": "content",
  "version": "1.0.0",
  "description": "Content creation and editing with search",
  "author": "studio-core",
  "tags": ["content", "writing", "research"],
  "type": "template",
  "studio_version": ">=7.0.0",
  "pipelines": ["content-creator"],
  "tools_included": ["search"]
}
```

`cli/templates/projects/content/project/pipelines/content-creator.pipeline.yaml`:
```yaml
name: content-creator
description: Research a topic and create content
version: 1

stages:
  - name: content-generation
    kind: content
    agent: writer
    ralph:
      max_attempts: 3
    context:
      include:
        - input
```

`cli/templates/projects/content/project/agents/writer.agent.yaml`:
```yaml
name: writer
provider: anthropic
model: claude-sonnet-4-6
tools:
  - search-search_codebase
system_prompt: |
  You are an expert content writer. Research the topic thoroughly using
  the search tool, then create high-quality, well-structured content.
```

`cli/templates/projects/content/project/contracts/content-output.contract.yaml`:
```yaml
name: content-output
version: 1
schema:
  required_fields:
    - title
    - content
    - summary
```

```bash
cp cli/templates/tools/search.tool.yaml cli/templates/projects/content/project/tools/
```

`cli/templates/projects/content/project/inputs/example.input.yaml`:
```yaml
topic: "The benefits of test-driven development"
format: "blog post"
tone: "professional"
target_length: "500 words"
```

---

### Step 1.4: Create document-analysis template

```bash
mkdir -p cli/templates/projects/document-analysis/project/{pipelines,agents,contracts,tools,inputs}
```

`cli/templates/projects/document-analysis/metadata.json`:
```json
{
  "name": "document-analysis",
  "version": "1.0.0",
  "description": "Document extraction and structured analysis",
  "author": "studio-core",
  "tags": ["analysis", "documents", "extraction"],
  "type": "template",
  "studio_version": ">=7.0.0",
  "pipelines": ["analyzer"],
  "tools_included": ["search"]
}
```

`cli/templates/projects/document-analysis/project/pipelines/analyzer.pipeline.yaml`:
```yaml
name: analyzer
description: Extract insights from a document or codebase
version: 1

stages:
  - name: analysis
    kind: analysis
    agent: analyst
    ralph:
      max_attempts: 3
    context:
      include:
        - input
```

`cli/templates/projects/document-analysis/project/agents/analyst.agent.yaml`:
```yaml
name: analyst
provider: anthropic
model: claude-sonnet-4-6
tools:
  - search-search_codebase
system_prompt: |
  You are an expert analyst. Search and read relevant content,
  then provide a structured analysis with clear findings and recommendations.
```

`cli/templates/projects/document-analysis/project/contracts/analysis-output.contract.yaml`:
```yaml
name: analysis-output
version: 1
schema:
  required_fields:
    - summary
    - key_findings
    - recommendations
```

```bash
cp cli/templates/tools/search.tool.yaml cli/templates/projects/document-analysis/project/tools/
```

`cli/templates/projects/document-analysis/project/inputs/example.input.yaml`:
```yaml
document_path: "."
analysis_goal: "Summarize the main patterns and suggest improvements"
```

---

### Step 1.5: Delete the orphan hello-world pipeline

```bash
rm cli/templates/pipelines/hello-world.pipeline.yaml
rmdir cli/templates/pipelines 2>/dev/null || true
```

---

### Step 1.6: Commit

```bash
git add cli/templates/projects/
git rm cli/templates/pipelines/hello-world.pipeline.yaml
git commit -m "feat(cli): add 4 built-in project templates (blank, software, content, document-analysis) (STU-33)"
```

---

## Task 2 — Update `init.ts` to copy template files

**Files:**
- Modify: `cli/src/commands/init.ts`
- Modify: `cli/tests/commands/init.test.ts`

---

### Step 2.1: Write the failing tests

Append these test cases to `cli/tests/commands/init.test.ts` (keep the existing tests, add after them):

```typescript
describe('createStudioStructure with templates', () => {
  it('copies template project files when templateName is software', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP, 'software', 'software');

    expect(await exists(resolve(TMP, '.studio', 'projects', 'software', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'software', 'agents', 'coder.agent.yaml'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'software', 'contracts', 'code-output.contract.yaml'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'software', 'tools', 'repo-manager.tool.yaml'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'software', 'inputs', 'example.input.yaml'))).toBe(true);
  });

  it('creates empty dirs for blank template (no project/ subdir)', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP, 'blank', 'blank');

    expect(await exists(resolve(TMP, '.studio', 'projects', 'blank', 'pipelines'))).toBe(true);
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(resolve(TMP, '.studio', 'projects', 'blank', 'pipelines'));
    expect(entries).toEqual([]);
  });

  it('throws with helpful message when template does not exist', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await expect(createStudioStructure(TMP, 'xyz', 'xyz')).rejects.toThrow(
      "Template 'xyz' not found"
    );
  });

  it('error message mentions studio templates list', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    try {
      await createStudioStructure(TMP, 'xyz', 'xyz');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err instanceof Error && err.message).toContain('studio templates list');
    }
  });

  it('custom project name with template: copies to named project dir', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP, 'my-app', 'software');

    expect(await exists(resolve(TMP, '.studio', 'projects', 'my-app', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);
  });
});
```

### Step 2.2: Run tests to verify failure

```bash
pnpm --filter @studio/cli test -- --reporter=verbose 2>&1 | grep -E "copies template|blank template|throws with|error message|custom project"
```

Expected: `TypeError: createStudioStructure is not a function` (wrong — it exists) or all 5 new tests should fail because `createStudioStructure` doesn't accept a 3rd argument yet. You'll see the template-copy tests fail because the files don't exist in the project dir.

---

### Step 2.3: Implement the changes in `init.ts`

Replace the full content of `cli/src/commands/init.ts`:

```typescript
import { mkdir, writeFile, readFile, access, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import chalk from 'chalk';
import { findStudioDir } from '../studio-dir.js';

const TEMPLATES_DIR = resolve(import.meta.dirname, '../../templates');

const GITIGNORE_ENTRIES = ['.studio/config.yaml', '.studio/runs/'];

const PROJECT_SUBDIRS = ['pipelines', 'agents', 'contracts', 'tools', 'inputs'];

/**
 * Create the full .studio/ directory structure in `cwd`.
 * If templateName is provided, copies the template's project/ subdir.
 * Throws if .studio/ already exists anywhere in the directory tree.
 */
export async function createStudioStructure(
  cwd: string,
  projectName = 'default',
  templateName?: string
): Promise<void> {
  // Check if already initialized
  const existing = await findStudioDir(cwd);
  if (existing) {
    throw new Error(
      `Studio is already initialized at ${existing}\n` +
        `If you want to reinitialize, delete the .studio/ directory first.`
    );
  }

  const studioDir = resolve(cwd, '.studio');
  const projectDir = join(studioDir, 'projects', projectName);

  if (templateName) {
    const templateDir = resolve(TEMPLATES_DIR, 'projects', templateName);

    // Verify template exists
    const templateExists = await access(templateDir).then(() => true).catch(() => false);
    if (!templateExists) {
      throw new Error(
        `Template '${templateName}' not found. Run 'studio templates list' to see available templates.`
      );
    }

    // Copy project/ subdir if present, otherwise create empty dirs
    const templateProjectDir = join(templateDir, 'project');
    const hasProjectDir = await access(templateProjectDir).then(() => true).catch(() => false);

    if (hasProjectDir) {
      await mkdir(projectDir, { recursive: true });
      await cp(templateProjectDir, projectDir, { recursive: true });
    } else {
      for (const sub of PROJECT_SUBDIRS) {
        await mkdir(join(projectDir, sub), { recursive: true });
      }
    }
  } else {
    // No template — create empty subdirectories
    for (const sub of PROJECT_SUBDIRS) {
      await mkdir(join(projectDir, sub), { recursive: true });
    }
  }

  // Create runs/logs/
  await mkdir(join(studioDir, 'runs', 'logs'), { recursive: true });

  // Write registry.lock.json (empty, committed)
  await writeFile(join(studioDir, 'registry.lock.json'), '{}\n', 'utf-8');

  // Copy config template (only if config.yaml doesn't already exist)
  const configPath = join(studioDir, 'config.yaml');
  const configExists = await access(configPath)
    .then(() => true)
    .catch(() => false);
  if (!configExists) {
    const template = await readFile(resolve(TEMPLATES_DIR, 'studio-config.yaml'), 'utf-8');
    await writeFile(configPath, template, 'utf-8');
  }

  // Update .gitignore
  await updateGitignore(cwd);
}

async function updateGitignore(cwd: string): Promise<void> {
  const gitignorePath = resolve(cwd, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(gitignorePath, 'utf-8');
  } catch {
    // file doesn't exist yet
  }

  const toAdd = GITIGNORE_ENTRIES.filter((entry) => !existing.includes(entry));
  if (toAdd.length === 0) return;

  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const addition = '\n# Studio (generated)\n' + toAdd.join('\n') + '\n';
  await writeFile(gitignorePath, existing + separator + addition, 'utf-8');
}

interface InitOptions {
  template?: string;
  project?: string;
}

export async function initCommand(options: InitOptions = {}): Promise<void> {
  try {
    const cwd = process.cwd();
    const templateName = options.template;
    const projectName = options.project ?? options.template ?? 'default';

    console.log(chalk.blue('\nInitializing Studio project...\n'));

    await createStudioStructure(cwd, projectName, templateName);

    console.log(chalk.gray(`  Created .studio/config.yaml`));
    console.log(
      chalk.gray(
        `  Created .studio/projects/${projectName}/{pipelines,agents,contracts,tools,inputs}/`
      )
    );
    console.log(chalk.gray(`  Created .studio/runs/logs/`));
    console.log(chalk.gray(`  Created .studio/registry.lock.json`));
    console.log(chalk.gray(`  Updated .gitignore`));
    console.log(chalk.green('\n✓ Studio project initialized'));
    console.log('');
    console.log('Next steps:');
    console.log(`  1. Set your API key: ${chalk.cyan('export ANTHROPIC_API_KEY=...')}`);
    console.log(
      `  2. Or: ${chalk.cyan('studio config set provider anthropic --api-key $ANTHROPIC_API_KEY')}`
    );
    console.log(
      `  3. Add your pipeline configs to: ${chalk.cyan(`.studio/projects/${projectName}/`)}`
    );
    console.log(
      `  4. Run: ${chalk.cyan(`studio run ${projectName}/my-pipeline --input "Hello!"`)}`
    );
    console.log('');
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
```

---

### Step 2.4: Run tests to verify pass

```bash
pnpm --filter @studio/cli test -- --reporter=verbose 2>&1 | grep -E "copies template|blank template|throws with|error message|custom project|✓|✗|FAIL|PASS"
```

Expected: all 5 new tests pass, all existing tests still pass.

---

### Step 2.5: Commit

```bash
git add cli/src/commands/init.ts cli/tests/commands/init.test.ts
git commit -m "feat(cli): add template copy logic to createStudioStructure (STU-33)"
```

---

## Task 3 — `templates.ts` command + `index.ts` registration

**Files:**
- Create: `cli/src/commands/templates.ts`
- Create: `cli/tests/commands/templates.test.ts`
- Modify: `cli/src/index.ts`

---

### Step 3.1: Write the failing tests

Create `cli/tests/commands/templates.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { listTemplates } from '../../src/commands/templates.js';

describe('listTemplates', () => {
  it('returns all 4 built-in templates', async () => {
    const templates = await listTemplates();
    const names = templates.map((t) => t.name);
    expect(names).toContain('blank');
    expect(names).toContain('software');
    expect(names).toContain('content');
    expect(names).toContain('document-analysis');
  });

  it('each template has name, version, description', async () => {
    const templates = await listTemplates();
    for (const t of templates) {
      expect(t.name).toBeTruthy();
      expect(t.version).toBeTruthy();
      expect(t.description).toBeTruthy();
    }
  });

  it('templates are sorted alphabetically', async () => {
    const templates = await listTemplates();
    const names = templates.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });
});
```

### Step 3.2: Run tests to verify failure

```bash
pnpm --filter @studio/cli test -- --reporter=verbose 2>&1 | grep -E "listTemplates|Cannot find|FAIL"
```

Expected: `Cannot find module '../../src/commands/templates.js'`

---

### Step 3.3: Create `cli/src/commands/templates.ts`

```typescript
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import chalk from 'chalk';

const PROJECTS_TEMPLATES_DIR = resolve(import.meta.dirname, '../../templates/projects');

export interface TemplateMetadata {
  name: string;
  version: string;
  description: string;
  author?: string;
  tags?: string[];
  type?: string;
  studio_version?: string;
  pipelines?: string[];
  tools_included?: string[];
}

export async function listTemplates(): Promise<TemplateMetadata[]> {
  try {
    const entries = await readdir(PROJECTS_TEMPLATES_DIR, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    const templates: TemplateMetadata[] = [];
    for (const dir of dirs) {
      try {
        const metaPath = join(PROJECTS_TEMPLATES_DIR, dir, 'metadata.json');
        const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as TemplateMetadata;
        templates.push(meta);
      } catch {
        // Skip malformed or missing metadata
      }
    }
    return templates;
  } catch {
    return [];
  }
}

export async function templatesCommand(action: string, _args: string[]): Promise<void> {
  try {
    switch (action) {
      case 'list': {
        const templates = await listTemplates();
        if (templates.length === 0) {
          console.log(chalk.yellow('No templates available.'));
          return;
        }
        console.log('\nAvailable templates:\n');
        const maxLen = Math.max(...templates.map((t) => t.name.length));
        for (const t of templates) {
          console.log(`  ${t.name.padEnd(maxLen + 2)}${chalk.gray(t.description)}`);
        }
        console.log('');
        console.log(`Run: ${chalk.cyan('studio init --template <name>')}`);
        console.log('');
        break;
      }
      default:
        console.error(`Unknown templates action: ${action}. Available: list`);
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
```

---

### Step 3.4: Run tests to verify pass

```bash
pnpm --filter @studio/cli test -- --reporter=verbose 2>&1 | grep -E "listTemplates|✓|✗|FAIL|PASS"
```

Expected: all 3 new tests pass.

---

### Step 3.5: Register `templates` command in `index.ts`

In `cli/src/index.ts`, add the import after the `toolsCommand` import:

```typescript
import { templatesCommand } from './commands/templates.js';
```

Add the command registration after the `tools` command block (before `program.parse()`):

```typescript
program
  .command('templates <action> [args...]')
  .description('Manage Studio templates (list)')
  .action(templatesCommand);
```

Also update the `init` command registration to include `--project`:

```typescript
program
  .command('init')
  .description('Initialize a new Studio project in the current directory')
  .option('--template <name>', 'Project template to use (e.g. software)')
  .option('--project <name>', 'Project name (defaults to template name or "default")')
  .action(initCommand);
```

---

### Step 3.6: Build

```bash
pnpm build
```

Expected: No TypeScript errors.

---

### Step 3.7: Commit

```bash
git add cli/src/commands/templates.ts cli/tests/commands/templates.test.ts cli/src/index.ts
git commit -m "feat(cli): add studio templates list command (STU-33)"
```

---

## Task 4 — Full test run + verification

### Step 4.1: Run all tests

```bash
pnpm test
```

Expected: All tests pass. No regressions. The `pnpm test` script runs `vitest run` in each package.

### Step 4.2: Manual smoke test (optional)

```bash
node cli/dist/index.js templates list
```

Expected output:
```
Available templates:

  blank              Empty project structure
  content            Content creation and editing with search
  document-analysis  Document extraction and structured analysis
  software           Code generation with repo, shell and search tools

Run: studio init --template <name>
```

### Step 4.3: Verify git log

```bash
git log --oneline -5
```

Expected: 3 clean feature commits for STU-33.

---

## Acceptance Criteria Check

| Criterion | Covered by |
|-----------|-----------|
| 4 templates created (blank, software, content, document-analysis) | Task 1 |
| `studio init --template <name>` copies template | Task 2 |
| `studio templates list` shows templates with descriptions | Task 3 |
| Each template has example input | Task 1 (all templates have `inputs/example.input.yaml`) |
| Templates include appropriate `.tool.yaml` files | Task 1 |
| `metadata.json` standardized for each template | Task 1 |
