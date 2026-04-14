# `on_pipeline_start` — Dynamic Context Injection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `on_pipeline_start` to the pipeline YAML format so shell commands run once at pipeline startup, their stdout is stored per `inject_as` key, and stages can opt in via `context.include: [pipeline_start_context]`.

**Architecture:** Contracts gets a new `StartupCommand` type. The engine parses the commands from YAML, executes them in a new `startup-executor.ts` module, stores results in `PipelineContext`, and `getContextForStage()` maps them to a new `startup_context` field on `AgentContext`. The runner's prompt builder renders each key as a `###` section.

**Tech Stack:** TypeScript, Node.js `child_process.exec` (promisified), Vitest

---

### Task 1: Add `StartupCommand` type to contracts

**Files:**
- Modify: `contracts/src/pipeline.ts`

**Step 1: Add the type and field**

In `contracts/src/pipeline.ts`, add before the `PipelineDefinition` interface:

```typescript
export interface StartupCommand {
  command: string;
  inject_as: string;
}
```

Then add to `PipelineDefinition`:

```typescript
export interface PipelineDefinition {
  name: string;
  description: string;
  version: number;
  input_schema?: InputSchema;
  on_pipeline_start?: StartupCommand[];   // ← add this line
  repo?: {
    url: string;
    branch?: string;
  };
  stages: PipelineEntry[];
}
```

**Step 2: Build contracts**

```bash
pnpm --filter @studio-foundation/contracts build
```
Expected: build succeeds with no errors.

**Step 3: Commit**

```bash
git add contracts/src/pipeline.ts
git commit -m "feat(contracts): add StartupCommand type and on_pipeline_start to PipelineDefinition"
```

---

### Task 2: Parse `on_pipeline_start` in the pipeline loader

**Files:**
- Modify: `engine/src/pipeline/loader.ts`
- Create: `engine/src/pipeline/loader.test.ts`

**Step 1: Write the failing test**

Create `engine/src/pipeline/loader.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parsePipelineYaml } from './loader.js';

const MINIMAL_STAGE = `
  - name: analyze
    kind: analysis
    agent: analyst
`;

describe('parsePipelineYaml — on_pipeline_start', () => {
  it('parses on_pipeline_start commands', () => {
    const yaml = `
name: test-pipeline
description: test
version: 1
on_pipeline_start:
  - command: "git status --short"
    inject_as: git_status
  - command: "git log --oneline -5"
    inject_as: recent_commits
stages:
${MINIMAL_STAGE}
`;
    const result = parsePipelineYaml(yaml);
    expect(result.on_pipeline_start).toEqual([
      { command: 'git status --short', inject_as: 'git_status' },
      { command: 'git log --oneline -5', inject_as: 'recent_commits' },
    ]);
  });

  it('returns undefined on_pipeline_start when absent', () => {
    const yaml = `
name: test-pipeline
description: test
version: 1
stages:
${MINIMAL_STAGE}
`;
    const result = parsePipelineYaml(yaml);
    expect(result.on_pipeline_start).toBeUndefined();
  });

  it('throws when on_pipeline_start entry is missing command', () => {
    const yaml = `
name: test-pipeline
description: test
version: 1
on_pipeline_start:
  - inject_as: git_status
stages:
${MINIMAL_STAGE}
`;
    expect(() => parsePipelineYaml(yaml)).toThrow("on_pipeline_start entry missing 'command'");
  });

  it('throws when on_pipeline_start entry is missing inject_as', () => {
    const yaml = `
name: test-pipeline
description: test
version: 1
on_pipeline_start:
  - command: "git status"
stages:
${MINIMAL_STAGE}
`;
    expect(() => parsePipelineYaml(yaml)).toThrow("on_pipeline_start entry missing 'inject_as'");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @studio-foundation/engine exec vitest run src/pipeline/loader.test.ts
```
Expected: FAIL — `on_pipeline_start` is undefined (not parsed yet).

**Step 3: Implement parsing in loader.ts**

In `engine/src/pipeline/loader.ts`, update `parsePipelineYaml`. Replace the `return { ...parsed, stages }` at the end with:

```typescript
  // Parse on_pipeline_start commands
  let on_pipeline_start: import('@studio-foundation/contracts').StartupCommand[] | undefined;
  if (Array.isArray(parsed.on_pipeline_start)) {
    on_pipeline_start = [];
    for (const cmd of parsed.on_pipeline_start as any[]) {
      if (!cmd.command || typeof cmd.command !== 'string') {
        throw new Error(`on_pipeline_start entry missing 'command'${context}`);
      }
      if (!cmd.inject_as || typeof cmd.inject_as !== 'string') {
        throw new Error(`on_pipeline_start entry missing 'inject_as'${context}`);
      }
      on_pipeline_start.push({ command: cmd.command, inject_as: cmd.inject_as });
    }
    if (on_pipeline_start.length === 0) {
      on_pipeline_start = undefined;
    }
  }

  return {
    ...parsed,
    stages,
    on_pipeline_start,
  } as unknown as PipelineDefinition;
```

**Step 4: Run test to verify it passes**

```bash
pnpm --filter @studio-foundation/engine exec vitest run src/pipeline/loader.test.ts
```
Expected: all 4 tests PASS.

**Step 5: Commit**

```bash
git add engine/src/pipeline/loader.ts engine/src/pipeline/loader.test.ts
git commit -m "feat(engine): parse on_pipeline_start commands from pipeline YAML"
```

---

### Task 3: Create `startup-executor.ts`

**Files:**
- Create: `engine/src/pipeline/startup-executor.ts`
- Create: `engine/src/pipeline/startup-executor.test.ts`

**Step 1: Write the failing tests**

Create `engine/src/pipeline/startup-executor.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { executeStartupCommands } from './startup-executor.js';

describe('executeStartupCommands', () => {
  it('returns stdout keyed by inject_as', async () => {
    const result = await executeStartupCommands([
      { command: 'echo hello', inject_as: 'greeting' },
      { command: 'echo world', inject_as: 'place' },
    ]);
    expect(result.greeting).toBe('hello');
    expect(result.place).toBe('world');
  });

  it('skips and warns when a command fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await executeStartupCommands([
      { command: 'exit 1', inject_as: 'bad' },
      { command: 'echo ok', inject_as: 'good' },
    ]);
    expect(result.bad).toBeUndefined();
    expect(result.good).toBe('ok');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[on_pipeline_start]'));
    warnSpy.mockRestore();
  });

  it('returns empty object when no commands given', async () => {
    const result = await executeStartupCommands([]);
    expect(result).toEqual({});
  });

  it('trims trailing newlines from stdout', async () => {
    const result = await executeStartupCommands([
      { command: 'printf "  trimmed  "', inject_as: 'val' },
    ]);
    expect(result.val).toBe('trimmed');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @studio-foundation/engine exec vitest run src/pipeline/startup-executor.test.ts
```
Expected: FAIL — module not found.

**Step 3: Implement startup-executor.ts**

Create `engine/src/pipeline/startup-executor.ts`:

```typescript
// Execute on_pipeline_start commands and collect their stdout

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { StartupCommand } from '@studio-foundation/contracts';

const execAsync = promisify(exec);
const COMMAND_TIMEOUT_MS = 10_000;

export async function executeStartupCommands(
  commands: StartupCommand[],
  cwd?: string
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  for (const cmd of commands) {
    try {
      const { stdout } = await execAsync(cmd.command, {
        cwd,
        timeout: COMMAND_TIMEOUT_MS,
      });
      result[cmd.inject_as] = stdout.trim();
    } catch (err) {
      console.warn(
        `[on_pipeline_start] command failed: "${cmd.command}" — ${(err as Error).message}`
      );
    }
  }

  return result;
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm --filter @studio-foundation/engine exec vitest run src/pipeline/startup-executor.test.ts
```
Expected: all 4 tests PASS.

**Step 5: Commit**

```bash
git add engine/src/pipeline/startup-executor.ts engine/src/pipeline/startup-executor.test.ts
git commit -m "feat(engine): add startup-executor to run on_pipeline_start commands"
```

---

### Task 4: Add `startupContext` to `PipelineContext` and new include case

**Files:**
- Modify: `engine/src/pipeline/context-propagation.ts`
- Create: `engine/src/pipeline/context-propagation.test.ts`

**Step 1: Write the failing tests**

Create `engine/src/pipeline/context-propagation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  createInitialContext,
  getContextForStage,
} from './context-propagation.js';
import type { StageDefinition } from '@studio-foundation/contracts';

const makeStage = (include: string[]): StageDefinition => ({
  name: 'test-stage',
  kind: 'analysis',
  agent: 'analyst',
  context: { include },
});

describe('getContextForStage — pipeline_start_context', () => {
  it('injects startup_context when stage includes pipeline_start_context', () => {
    const ctx = createInitialContext('my input');
    ctx.startupContext = { git_status: 'M src/foo.ts', recent_commits: 'abc123 feat: stuff' };

    const agentCtx = getContextForStage(ctx, makeStage(['pipeline_start_context']));
    expect(agentCtx.startup_context).toEqual({
      git_status: 'M src/foo.ts',
      recent_commits: 'abc123 feat: stuff',
    });
  });

  it('does not inject startup_context when not in include list', () => {
    const ctx = createInitialContext('my input');
    ctx.startupContext = { git_status: 'M src/foo.ts' };

    const agentCtx = getContextForStage(ctx, makeStage(['input']));
    expect(agentCtx.startup_context).toBeUndefined();
  });

  it('does not inject startup_context when startupContext is empty', () => {
    const ctx = createInitialContext('my input');
    ctx.startupContext = {};

    const agentCtx = getContextForStage(ctx, makeStage(['pipeline_start_context']));
    expect(agentCtx.startup_context).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @studio-foundation/engine exec vitest run src/pipeline/context-propagation.test.ts
```
Expected: FAIL — `startupContext` doesn't exist on `PipelineContext`.

**Step 3: Update context-propagation.ts**

In `engine/src/pipeline/context-propagation.ts`:

1. Add `startupContext?: Record<string, string>` to `PipelineContext`:

```typescript
export interface PipelineContext {
  input: PipelineInput;
  stageOutputs: Map<string, unknown>;
  stageToolResults: Map<string, ToolCall[]>;
  repoPath?: string;
  groupFeedback?: GroupFeedback;
  startupContext?: Record<string, string>;   // ← add
}
```

2. Add a new `case` inside the `for (const include of includes)` switch in `getContextForStage()`:

```typescript
      case 'pipeline_start_context':
        if (context.startupContext && Object.keys(context.startupContext).length > 0) {
          agentContext.startup_context = context.startupContext;
        }
        break;
```

**Step 4: Run test to verify it passes**

```bash
pnpm --filter @studio-foundation/engine exec vitest run src/pipeline/context-propagation.test.ts
```
Expected: all 3 tests PASS.

**Step 5: Commit**

```bash
git add engine/src/pipeline/context-propagation.ts engine/src/pipeline/context-propagation.test.ts
git commit -m "feat(engine): add startupContext to PipelineContext and pipeline_start_context include case"
```

---

### Task 5: Add `startup_context` to `AgentContext` and render in prompt builder

**Files:**
- Modify: `runner/src/prompt-builder.ts`
- Create: `runner/src/prompt-builder.test.ts`

**Step 1: Write the failing tests**

Create `runner/src/prompt-builder.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildPrompt } from './prompt-builder.js';
import type { AgentConfig } from '@studio-foundation/contracts';

const AGENT: AgentConfig = {
  name: 'test-agent',
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  system_prompt: 'You are a helpful assistant.',
};

const TASK = { description: 'Do the thing.' };

describe('buildPrompt — startup_context', () => {
  it('renders each startup_context key as a ### section under ## Pipeline Startup Context', () => {
    const messages = buildPrompt({
      agent: AGENT,
      task: TASK,
      context: {
        startup_context: {
          git_status: 'M src/foo.ts',
          recent_commits: 'abc123 feat: stuff',
        },
      },
    });
    const userMsg = messages.find(m => m.role === 'user')!.content as string;
    expect(userMsg).toContain('## Pipeline Startup Context');
    expect(userMsg).toContain('### git_status');
    expect(userMsg).toContain('M src/foo.ts');
    expect(userMsg).toContain('### recent_commits');
    expect(userMsg).toContain('abc123 feat: stuff');
  });

  it('omits the section when startup_context is absent', () => {
    const messages = buildPrompt({
      agent: AGENT,
      task: TASK,
      context: {},
    });
    const userMsg = messages.find(m => m.role === 'user')!.content as string;
    expect(userMsg).not.toContain('Pipeline Startup Context');
  });

  it('omits the section when startup_context is empty', () => {
    const messages = buildPrompt({
      agent: AGENT,
      task: TASK,
      context: { startup_context: {} },
    });
    const userMsg = messages.find(m => m.role === 'user')!.content as string;
    expect(userMsg).not.toContain('Pipeline Startup Context');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @studio-foundation/runner exec vitest run src/prompt-builder.test.ts
```
Expected: FAIL — `startup_context` not in `AgentContext`, section not rendered.

**Step 3: Add `startup_context` to `AgentContext` in prompt-builder.ts**

In `runner/src/prompt-builder.ts`, update the `AgentContext` interface:

```typescript
export interface AgentContext {
  previous_outputs?: Record<string, unknown>;
  previous_tool_results?: Record<string, ToolCall[]>;
  repo_files?: string[];
  additional_context?: string;
  context_packs?: ResolvedContextPack[];
  startup_context?: Record<string, string>;   // ← add
}
```

**Step 4: Render startup_context in buildPrompt**

In `buildPrompt()`, after the `additional_context` block (around line 136) and before the context packs block, add:

```typescript
  // Render pipeline startup context — each key as a ### section
  if (context.startup_context && Object.keys(context.startup_context).length > 0) {
    userContent += '## Pipeline Startup Context\n\n';
    for (const [key, value] of Object.entries(context.startup_context)) {
      userContent += `### ${key}\n\`\`\`\n${value}\n\`\`\`\n\n`;
    }
  }
```

**Step 5: Run test to verify it passes**

```bash
pnpm --filter @studio-foundation/runner exec vitest run src/prompt-builder.test.ts
```
Expected: all 3 tests PASS.

**Step 6: Commit**

```bash
git add runner/src/prompt-builder.ts runner/src/prompt-builder.test.ts
git commit -m "feat(runner): add startup_context to AgentContext and render as Pipeline Startup Context sections"
```

---

### Task 6: Wire `executeStartupCommands` into `engine.run()`

**Files:**
- Modify: `engine/src/engine.ts`

There is no isolated unit test for this wiring (it would require mocking child_process deeply). The integration is covered by Task 7's build verification and the existing test suite.

**Step 1: Import the executor**

In `engine/src/engine.ts`, add to the imports:

```typescript
import { executeStartupCommands } from './pipeline/startup-executor.js';
```

**Step 2: Call the executor after `createInitialContext()`**

In `engine.run()`, after line:
```typescript
const pipelineContext = createInitialContext(input.input, this.config.repoPath);
```

Add:
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

**Step 3: Build engine**

```bash
pnpm --filter @studio-foundation/engine build
```
Expected: build succeeds with no TypeScript errors.

**Step 4: Run all engine tests**

```bash
pnpm --filter @studio-foundation/engine test
```
Expected: all tests PASS.

**Step 5: Commit**

```bash
git add engine/src/engine.ts
git commit -m "feat(engine): execute on_pipeline_start commands and inject into pipeline context"
```

---

### Task 7: Full build + all tests

**Step 1: Build entire monorepo**

```bash
pnpm build
```
Expected: all 5 packages build successfully.

**Step 2: Run all tests**

```bash
pnpm test
```
Expected: all tests PASS across contracts, ralph, runner, engine, cli.

**Step 3: Final commit if needed**

If any small fixups were needed, commit them:
```bash
git add -p
git commit -m "fix: address build issues from on_pipeline_start integration"
```

---

### Task 8: Update the software template pipeline

**Files:**
- Modify: `templates/software/.studio/pipelines/feature-builder.pipeline.yaml` (if it exists)
- Or create a representative example in the design doc

Check if the template pipeline exists:
```bash
ls templates/software/.studio/pipelines/
```

If `feature-builder.pipeline.yaml` exists, add the `on_pipeline_start` section as a commented-out example:

```yaml
# on_pipeline_start:
#   - command: "git status --short"
#     inject_as: git_status
#   - command: "git log --oneline -5"
#     inject_as: recent_commits
#   - command: "cat package.json | jq '.scripts' 2>/dev/null || echo '{}'"
#     inject_as: available_scripts
```

And add `pipeline_start_context` to the `context.include` of `brief-analysis` stage.

**Step: Commit**
```bash
git add templates/
git commit -m "chore(templates): add on_pipeline_start example to software template"
```

---

## Summary of files changed

| Package | File | Action |
|---------|------|--------|
| contracts | `src/pipeline.ts` | Add `StartupCommand` type + field |
| engine | `src/pipeline/loader.ts` | Parse `on_pipeline_start` |
| engine | `src/pipeline/loader.test.ts` | New |
| engine | `src/pipeline/startup-executor.ts` | New |
| engine | `src/pipeline/startup-executor.test.ts` | New |
| engine | `src/pipeline/context-propagation.ts` | Add field + case |
| engine | `src/pipeline/context-propagation.test.ts` | New |
| engine | `src/engine.ts` | Call executor |
| runner | `src/prompt-builder.ts` | Add field + render |
| runner | `src/prompt-builder.test.ts` | New |
| templates | `software/.studio/pipelines/*.yaml` | Example (if exists) |
