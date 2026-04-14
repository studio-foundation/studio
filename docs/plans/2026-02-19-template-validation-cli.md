# Template Validation CLI Implementation Plan (STU-70)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `studio template validate <path>` command that verifies a template directory is structurally sound, has valid YAML, and has consistent cross-references between pipelines, contracts, and agents.

**Architecture:** New command registered as `studio template <action>` in the CLI. Core validation logic lives in `cli/src/commands/template/validate.ts` as a pure function (no Commander dependency), making it independently testable. CLI dispatcher lives in `cli/src/commands/template/index.ts`. Validation runs in two sequential levels: structural (file existence, counts) then semantic (YAML parsing, cross-references). Optional third level for TypeScript compilation if `tsconfig.json` is present.

**Tech Stack:** Node.js fs/promises, js-yaml (already a dependency), chalk (already a dep), vitest. `execa` or `node:child_process` for optional `tsc --noEmit`. No new dependencies needed.

---

## Template directory structure expected by the validator

```
<template-path>/
├── metadata.json          # Required — { name, version, description }
└── project/               # Required
    ├── pipelines/         # ≥1 .pipeline.yaml
    ├── agents/            # ≥1 .agent.yaml
    ├── contracts/         # directory must exist
    ├── tools/             # optional
    └── inputs/            # optional

Optional at top level:
├── tsconfig.json          # if present → run tsc --noEmit
└── prisma/schema.prisma   # if present → report it (no live migration run)
```

Pipeline stages reference contracts and agents by name stem (e.g., `contract: brief-analysis` → `contracts/brief-analysis.contract.yaml`).

---

## What the validator checks

**Level 1 — Structural (fast, no YAML parsing):**
1. Template directory exists
2. `metadata.json` exists and is valid JSON with `name`, `version`, `description`
3. `project/pipelines/` exists and contains ≥2 `.pipeline.yaml` files
4. `project/agents/` exists and contains ≥1 `.agent.yaml` file
5. `project/contracts/` directory exists

**Level 2 — Semantic (YAML parse + cross-references):**
1. All `.pipeline.yaml` files parse without errors (js-yaml)
2. All `.contract.yaml` files parse without errors
3. All `.agent.yaml` files parse without errors
4. All `.tool.yaml` files parse without errors
5. Each pipeline stage's `contract:` field resolves to an existing `.contract.yaml` file
6. Each pipeline stage's `agent:` field resolves to an existing `.agent.yaml` file

**Level 3 — Optional compilation check:**
- If `tsconfig.json` exists at root of template path → run `tsc --noEmit` via `child_process.spawnSync`
- Failure = non-zero exit code from tsc

**Output format:**
```
✓ Structural validation passed
✓ Semantic validation passed
✗ Compilation check failed
  TypeScript error: src/index.ts(12,3): error TS2345: ...
```

Exit code 0 on all-pass, 1 on any failure.

---

### Task 1: Create the core validator function (TDD)

**Files:**
- Create: `cli/src/commands/template/validate.ts`
- Create: `cli/tests/commands/template/validate.test.ts`

**Step 1: Create the test file with failing tests**

Create `cli/tests/commands/template/validate.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { validateTemplateDir } from '../../src/commands/template/validate.js';

// Use /tmp — never a subdirectory of the Studio repo
const TMP = resolve('/tmp', '.studio-template-validate-test');

async function makeTemplate(overrides: {
  metadata?: Record<string, unknown> | null;
  pipelines?: Record<string, string>;  // name → yaml content
  agents?: Record<string, string>;
  contracts?: Record<string, string>;
} = {}): Promise<string> {
  const dir = join(TMP, String(Date.now()));
  const projectDir = join(dir, 'project');
  await mkdir(join(projectDir, 'pipelines'), { recursive: true });
  await mkdir(join(projectDir, 'agents'), { recursive: true });
  await mkdir(join(projectDir, 'contracts'), { recursive: true });
  await mkdir(join(projectDir, 'tools'), { recursive: true });
  await mkdir(join(projectDir, 'inputs'), { recursive: true });

  // metadata.json
  if (overrides.metadata !== null) {
    const meta = overrides.metadata ?? { name: 'test', version: '1.0.0', description: 'Test template' };
    await writeFile(join(dir, 'metadata.json'), JSON.stringify(meta));
  }

  // pipelines — default: 2 valid pipelines
  const pipelines = overrides.pipelines ?? {
    'pipe-one': 'name: pipe-one\nstages:\n  - name: s1\n    kind: analysis\n    agent: analyst\n    contract: output\n',
    'pipe-two': 'name: pipe-two\nstages:\n  - name: s2\n    kind: analysis\n    agent: analyst\n    contract: output\n',
  };
  for (const [name, content] of Object.entries(pipelines)) {
    await writeFile(join(projectDir, 'pipelines', `${name}.pipeline.yaml`), content);
  }

  // agents — default: 1 valid agent
  const agents = overrides.agents ?? {
    analyst: 'name: analyst\nprovider: anthropic\nmodel: claude-haiku-4-20250514\n',
  };
  for (const [name, content] of Object.entries(agents)) {
    await writeFile(join(projectDir, 'agents', `${name}.agent.yaml`), content);
  }

  // contracts — default: 1 valid contract
  const contracts = overrides.contracts ?? {
    output: 'name: output\nversion: 1\nschema:\n  required_fields:\n    - summary\n',
  };
  for (const [name, content] of Object.entries(contracts)) {
    await writeFile(join(projectDir, 'contracts', `${name}.contract.yaml`), content);
  }

  return dir;
}

beforeEach(async () => { await mkdir(TMP, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

describe('validateTemplateDir — Level 1: Structural', () => {
  it('returns valid for a well-formed minimal template', async () => {
    const dir = await makeTemplate();
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('errors when directory does not exist', async () => {
    const result = await validateTemplateDir('/tmp/does-not-exist-xyz');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('not found') || e.includes('does not exist'))).toBe(true);
  });

  it('errors when metadata.json is missing', async () => {
    const dir = await makeTemplate({ metadata: null });
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('metadata.json'))).toBe(true);
  });

  it('errors when metadata.json is missing required field', async () => {
    const dir = await makeTemplate({ metadata: { name: 'test' } }); // missing version + description
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('version') || e.includes('description'))).toBe(true);
  });

  it('errors when fewer than 2 pipelines exist', async () => {
    const dir = await makeTemplate({
      pipelines: { 'only-one': 'name: only-one\nstages:\n  - name: s1\n    kind: analysis\n    agent: analyst\n    contract: output\n' },
    });
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('pipeline') && e.includes('2'))).toBe(true);
  });

  it('errors when no agents exist', async () => {
    const dir = await makeTemplate({ agents: {} });
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('agent'))).toBe(true);
  });
});

describe('validateTemplateDir — Level 2: Semantic', () => {
  it('errors on invalid YAML in a pipeline file', async () => {
    const dir = await makeTemplate({
      pipelines: {
        'pipe-one': 'name: pipe-one\nstages:\n  - name: s1\n    kind: analysis\n    agent: analyst\n    contract: output\n',
        'pipe-bad': ': invalid: yaml: [\n',
      },
    });
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('pipe-bad'))).toBe(true);
  });

  it('errors when pipeline stage references a contract that does not exist', async () => {
    const dir = await makeTemplate({
      pipelines: {
        'pipe-one': 'name: pipe-one\nstages:\n  - name: s1\n    kind: analysis\n    agent: analyst\n    contract: output\n',
        'pipe-two': 'name: pipe-two\nstages:\n  - name: s2\n    kind: analysis\n    agent: analyst\n    contract: missing-contract\n',
      },
    });
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('missing-contract'))).toBe(true);
  });

  it('errors when pipeline stage references an agent that does not exist', async () => {
    const dir = await makeTemplate({
      pipelines: {
        'pipe-one': 'name: pipe-one\nstages:\n  - name: s1\n    kind: analysis\n    agent: analyst\n    contract: output\n',
        'pipe-two': 'name: pipe-two\nstages:\n  - name: s2\n    kind: analysis\n    agent: missing-agent\n    contract: output\n',
      },
    });
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('missing-agent'))).toBe(true);
  });

  it('validates stages inside groups', async () => {
    const dir = await makeTemplate({
      pipelines: {
        'pipe-one': 'name: pipe-one\nstages:\n  - name: s1\n    kind: analysis\n    agent: analyst\n    contract: output\n',
        'pipe-group': `name: pipe-group
stages:
  - group: my-group
    max_iterations: 3
    stages:
      - name: s1
        kind: analysis
        agent: analyst
        contract: output
      - name: s2
        kind: qa
        agent: analyst
        contract: ghost-contract
`,
      },
    });
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('ghost-contract'))).toBe(true);
  });
});
```

**Step 2: Run the test to confirm it fails (no implementation yet)**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm --filter @studio-foundation/cli test -- --reporter=verbose 2>&1 | tail -30
```

Expected: FAIL — `validateTemplateDir` not found / module not found.

**Step 3: Implement `cli/src/commands/template/validate.ts`**

```typescript
import { access, readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import * as yaml from 'js-yaml';
import { spawnSync } from 'node:child_process';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface StageDefinition {
  name: string;
  agent?: string;
  contract?: string;
}

interface PipelineEntry {
  group?: string;
  stages?: StageDefinition[];
  name?: string;
  agent?: string;
  contract?: string;
}

function collectStages(entries: PipelineEntry[]): StageDefinition[] {
  const stages: StageDefinition[] = [];
  for (const entry of entries) {
    if (entry.group && Array.isArray(entry.stages)) {
      stages.push(...entry.stages);
    } else {
      stages.push(entry as StageDefinition);
    }
  }
  return stages;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function listYamlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith('.yaml') || e.endsWith('.yml'));
  } catch {
    return [];
  }
}

export async function validateTemplateDir(templatePath: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Level 1: Structural ──────────────────────────────────────────────

  // 1. Template directory must exist
  if (!(await dirExists(templatePath))) {
    return { valid: false, errors: [`Template directory not found: ${templatePath}`], warnings };
  }

  // 2. metadata.json must exist and have required fields
  const metaPath = join(templatePath, 'metadata.json');
  let metaName = '';
  try {
    const raw = await readFile(metaPath, 'utf-8');
    const meta = JSON.parse(raw) as Record<string, unknown>;
    const required = ['name', 'version', 'description'];
    for (const field of required) {
      if (!meta[field]) errors.push(`metadata.json: missing required field '${field}'`);
    }
    metaName = String(meta.name ?? '');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      errors.push('metadata.json: file not found');
    } else {
      errors.push(`metadata.json: ${(err as Error).message}`);
    }
  }

  // 3. project/ directory must exist
  const projectDir = join(templatePath, 'project');
  if (!(await dirExists(projectDir))) {
    errors.push('project/ directory not found');
    return { valid: errors.length === 0, errors, warnings };
  }

  // 4. pipelines/ must have ≥2 .pipeline.yaml files
  const pipelinesDir = join(projectDir, 'pipelines');
  const pipelineFiles = (await listYamlFiles(pipelinesDir)).filter((f) => f.endsWith('.pipeline.yaml'));
  if (pipelineFiles.length < 2) {
    errors.push(
      `project/pipelines/: found ${pipelineFiles.length} pipeline(s), need at least 2`
    );
  }

  // 5. agents/ must have ≥1 .agent.yaml file
  const agentsDir = join(projectDir, 'agents');
  const agentFiles = (await listYamlFiles(agentsDir)).filter((f) => f.endsWith('.agent.yaml'));
  if (agentFiles.length < 1) {
    errors.push('project/agents/: no .agent.yaml files found (need at least 1)');
  }

  // 6. contracts/ directory must exist
  const contractsDir = join(projectDir, 'contracts');
  if (!(await dirExists(contractsDir))) {
    errors.push('project/contracts/ directory not found');
  }

  // Stop here if structural errors exist
  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // ── Level 2: Semantic (YAML parse + cross-references) ────────────────

  // Collect known agent and contract stems
  const knownAgents = new Set(agentFiles.map((f) => basename(f, '.agent.yaml')));
  const contractFiles = (await listYamlFiles(contractsDir)).filter((f) => f.endsWith('.contract.yaml'));
  const knownContracts = new Set(contractFiles.map((f) => basename(f, '.contract.yaml')));

  // Parse and validate each YAML file type
  const allYamlDirs: [string, string][] = [
    [pipelinesDir, 'pipelines'],
    [agentsDir, 'agents'],
    [contractsDir, 'contracts'],
    [join(projectDir, 'tools'), 'tools'],
  ];

  const parsedPipelines: Array<{ file: string; parsed: Record<string, unknown> }> = [];

  for (const [dir, label] of allYamlDirs) {
    const files = await listYamlFiles(dir);
    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const content = await readFile(filePath, 'utf-8');
        const parsed = yaml.load(content) as Record<string, unknown>;
        if (label === 'pipelines') {
          parsedPipelines.push({ file, parsed });
        }
      } catch (err) {
        errors.push(`${label}/${file}: YAML parse error — ${(err as Error).message}`);
      }
    }
  }

  // Cross-reference check: pipeline stages → contracts and agents
  for (const { file, parsed } of parsedPipelines) {
    if (!parsed || !Array.isArray(parsed.stages)) continue;
    const stages = collectStages(parsed.stages as PipelineEntry[]);
    for (const stage of stages) {
      if (stage.contract && !knownContracts.has(stage.contract)) {
        errors.push(
          `pipelines/${file}: stage '${stage.name ?? '?'}' references contract '${stage.contract}' which does not exist in contracts/`
        );
      }
      if (stage.agent && !knownAgents.has(stage.agent)) {
        errors.push(
          `pipelines/${file}: stage '${stage.name ?? '?'}' references agent '${stage.agent}' which does not exist in agents/`
        );
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // ── Level 3: Optional — TypeScript compilation ────────────────────────

  const tsConfigPath = join(templatePath, 'tsconfig.json');
  if (await dirExists(tsConfigPath)) {
    const result = spawnSync('tsc', ['--noEmit'], { cwd: templatePath, encoding: 'utf-8' });
    if (result.status !== 0) {
      const output = (result.stdout ?? '') + (result.stderr ?? '');
      errors.push(`TypeScript compilation failed:\n${output.trim()}`);
    }
  }

  // Informational: note prisma schema if present
  const prismaSchema = join(templatePath, 'prisma', 'schema.prisma');
  if (await dirExists(prismaSchema)) {
    warnings.push('prisma/schema.prisma found (migration testing not automated — run prisma validate manually)');
  }

  // Informational: name from metadata
  if (metaName) {
    warnings.push(`Template: ${metaName}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}
```

**Step 4: Run the tests to confirm they pass**

```bash
pnpm --filter @studio-foundation/cli test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|✓|✗|validateTemplateDir)" | head -40
```

Expected: All `validateTemplateDir` tests PASS.

**Step 5: Commit**

```bash
git add cli/src/commands/template/validate.ts cli/tests/commands/template/validate.test.ts
git commit -m "feat(cli): add validateTemplateDir core function (STU-70)"
```

---

### Task 2: Create the CLI command dispatcher

**Files:**
- Create: `cli/src/commands/template/index.ts`
- Modify: `cli/src/index.ts`

**Step 1: Create `cli/src/commands/template/index.ts`**

```typescript
import { resolve } from 'node:path';
import chalk from 'chalk';
import { validateTemplateDir } from './validate.js';

export async function templateCommand(action: string, args: string[]): Promise<void> {
  try {
    switch (action) {
      case 'validate': {
        const pathArg = args[0];
        if (!pathArg) {
          console.error('Usage: studio template validate <path>');
          process.exit(1);
        }
        const templatePath = resolve(pathArg);
        console.log('');
        console.log(`Validating template at: ${chalk.cyan(templatePath)}`);
        console.log('');

        const result = await validateTemplateDir(templatePath);

        if (result.valid) {
          console.log(chalk.green('✓ Structural validation passed'));
          console.log(chalk.green('✓ Semantic validation passed'));
        } else {
          // Determine where it failed
          const hasStructural = result.errors.some(
            (e) =>
              e.includes('metadata.json') ||
              e.includes('project/') ||
              e.includes('pipelines') ||
              e.includes('agents') ||
              e.includes('contracts')
          );
          if (hasStructural) {
            console.log(chalk.red('✗ Structural validation failed'));
          } else {
            console.log(chalk.green('✓ Structural validation passed'));
            console.log(chalk.red('✗ Semantic validation failed'));
          }
          console.log('');
          for (const error of result.errors) {
            for (const line of error.split('\n')) {
              console.log(`  ${chalk.red(line)}`);
            }
          }
        }

        if (result.warnings.length > 0) {
          console.log('');
          for (const warning of result.warnings) {
            console.log(`  ${chalk.yellow('⚠')} ${chalk.gray(warning)}`);
          }
        }

        console.log('');
        process.exit(result.valid ? 0 : 1);
      }

      default:
        console.error(`Unknown template action: ${action}. Available: validate`);
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
```

**Step 2: Register in `cli/src/index.ts`**

Add import after the existing `templatesCommand` import (around line 13):
```typescript
import { templateCommand } from './commands/template/index.js';
```

Add command registration after the existing `templates` command (around line 93):
```typescript
program
  .command('template <action> [args...]')
  .description('Template operations (validate)')
  .action(templateCommand);
```

**Step 3: Run all CLI tests to confirm nothing broke**

```bash
pnpm --filter @studio-foundation/cli test 2>&1 | tail -20
```

Expected: All tests pass.

**Step 4: Build to confirm TypeScript compiles**

```bash
pnpm build 2>&1 | tail -20
```

Expected: Build succeeds with no errors.

**Step 5: Smoke test against an existing template**

```bash
node cli/dist/index.js template validate cli/templates/projects/software-full
```

Expected output: Something like:
```
Validating template at: /path/to/cli/templates/projects/software-full

✗ Structural validation failed

  project/pipelines/: found 1 pipeline(s), need at least 2

  ⚠ Template: software-full
```

(The existing template has only 1 pipeline, which correctly fails the ≥2 check.)

**Step 6: Smoke test against a non-existent path**

```bash
node cli/dist/index.js template validate /tmp/no-such-template && echo "exit 0" || echo "exit 1"
```

Expected: Error message + `exit 1`.

**Step 7: Commit**

```bash
git add cli/src/commands/template/index.ts cli/src/index.ts
git commit -m "feat(cli): add studio template validate command (STU-70)"
```

---

### Task 3: Update Linear issue and finalize

**Step 1: Run the full test suite**

```bash
pnpm test 2>&1 | tail -30
```

Expected: All tests pass.

**Step 2: Mark STU-70 In Progress → Done in Linear**

Update issue STU-70 status to Done.

**Step 3: Push and open PR**

Follow the Git workflow from CLAUDE.md:
```bash
git push -u origin arianedguay/stu-70-implement-template-validation-cli
gh pr create \
  --title "feat(cli): implement studio template validate command (STU-70)" \
  --body "$(cat <<'EOF'
## Summary
- Adds `studio template validate <path>` CLI command
- Validates template structure (metadata.json, pipelines, agents, contracts)
- Parses all YAML files for syntax errors
- Cross-references pipeline stage agents/contracts against actual files
- Optional TypeScript compilation check if tsconfig.json present
- Exit code 0 on success, 1 on failure

## Packages touched
- `cli` — new `commands/template/validate.ts` + `commands/template/index.ts`, updated `index.ts`

## How to test
```bash
pnpm build
node cli/dist/index.js template validate cli/templates/projects/software-full
node cli/dist/index.js template validate /tmp/no-such-path
pnpm test
```

Closes STU-70

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" \
  --base main
```
