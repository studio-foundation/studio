# Tool Results Context Propagation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `previous_stage_tool_results` include option so subsequent pipeline stages receive the actual tool call results (search results, file contents) from earlier stages, eliminating redundant re-searching.

**Architecture:** Three additive changes across two packages. `PipelineContext` (engine) gains a `stageToolResults` map alongside the existing `stageOutputs`. `AgentContext` (runner) gains a `previous_tool_results` field rendered as a "Previous Stage Discoveries" prompt section. Pipeline YAMLs opt in via `context.include`.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces monorepo

---

### Task 1: Extend `PipelineContext` with `stageToolResults`

**Files:**
- Modify: `engine/src/pipeline/context-propagation.ts`
- Modify: `engine/tests/context-propagation.test.ts`

**Step 1: Write failing tests**

Add to `engine/tests/context-propagation.test.ts`, after the existing `addStageOutput` describe block:

```typescript
import type { ToolCall } from '@studio-foundation/contracts';

describe('addStageToolResults', () => {
  it('stores tool calls by stage name', () => {
    const ctx = createInitialContext('test');
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'search-search_codebase', arguments: { pattern: 'about' }, result: { matches: [] } },
    ];
    addStageToolResults(ctx, 'brief-analysis', toolCalls);
    expect(ctx.stageToolResults.get('brief-analysis')).toEqual(toolCalls);
  });

  it('accumulates tool results across stages', () => {
    const ctx = createInitialContext('test');
    addStageToolResults(ctx, 'stage-1', [{ id: '1', name: 'tool-a', arguments: {}, result: 'r1' }]);
    addStageToolResults(ctx, 'stage-2', [{ id: '2', name: 'tool-b', arguments: {}, result: 'r2' }]);
    expect(ctx.stageToolResults.size).toBe(2);
  });
});

describe('getContextForStage — previous_stage_tool_results', () => {
  it('includes tool calls from the previous stage', () => {
    const ctx = createInitialContext('test');
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'search-search_codebase', arguments: { pattern: 'about' }, result: { matches: ['about.tsx'] } },
    ];
    addStageToolResults(ctx, 'brief-analysis', toolCalls);

    const stage = makeStage({ context: { include: ['previous_stage_tool_results'] } });
    const agentCtx = getContextForStage(ctx, stage, 'brief-analysis');

    expect(agentCtx.previous_tool_results).toEqual({ 'brief-analysis': toolCalls });
  });

  it('returns empty when no previous stage tool results', () => {
    const ctx = createInitialContext('test');
    const stage = makeStage({ context: { include: ['previous_stage_tool_results'] } });
    const agentCtx = getContextForStage(ctx, stage, 'nonexistent');
    expect(agentCtx.previous_tool_results).toBeUndefined();
  });
});

describe('getContextForStage — all_stage_tool_results', () => {
  it('includes tool calls from all stages', () => {
    const ctx = createInitialContext('test');
    const tc1: ToolCall[] = [{ id: '1', name: 'tool-a', arguments: {}, result: 'r1' }];
    const tc2: ToolCall[] = [{ id: '2', name: 'tool-b', arguments: {}, result: 'r2' }];
    addStageToolResults(ctx, 'stage-1', tc1);
    addStageToolResults(ctx, 'stage-2', tc2);

    const stage = makeStage({ context: { include: ['all_stage_tool_results'] } });
    const agentCtx = getContextForStage(ctx, stage);

    expect(agentCtx.previous_tool_results).toEqual({ 'stage-1': tc1, 'stage-2': tc2 });
  });
});
```

**Step 2: Run tests to confirm they fail**

```bash
cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/engine test
```

Expected: FAIL — `addStageToolResults is not a function`, `ctx.stageToolResults is not a Map`

**Step 3: Implement the changes**

In `engine/src/pipeline/context-propagation.ts`:

1. Add `ToolCall` import at the top:
```typescript
import type { StageDefinition, ToolCall } from '@studio-foundation/contracts';
```

2. Add `stageToolResults` to `PipelineContext`:
```typescript
export interface PipelineContext {
  input: PipelineInput;
  stageOutputs: Map<string, unknown>;
  stageToolResults: Map<string, ToolCall[]>;   // ← add this
  repoPath?: string;
  groupFeedback?: GroupFeedback;
}
```

3. Initialize in `createInitialContext`:
```typescript
export function createInitialContext(input: PipelineInput, repoPath?: string): PipelineContext {
  return {
    input,
    stageOutputs: new Map(),
    stageToolResults: new Map(),               // ← add this
    repoPath,
  };
}
```

4. Add `addStageToolResults` function (after `addStageOutput`):
```typescript
export function addStageToolResults(
  context: PipelineContext,
  stageName: string,
  toolCalls: ToolCall[]
): void {
  context.stageToolResults.set(stageName, toolCalls);
}
```

5. Add two new cases in `getContextForStage` switch, before the `case 'repo_files'` case:
```typescript
      case 'previous_stage_tool_results':
        if (previousStageName) {
          const toolResults = context.stageToolResults.get(previousStageName);
          if (toolResults) {
            agentContext.previous_tool_results = {
              ...agentContext.previous_tool_results,
              [previousStageName]: toolResults,
            };
          }
        }
        break;

      case 'all_stage_tool_results':
        if (context.stageToolResults.size > 0) {
          agentContext.previous_tool_results = {
            ...agentContext.previous_tool_results,
            ...Object.fromEntries(context.stageToolResults),
          };
        }
        break;
```

**Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @studio-foundation/engine test
```

Expected: all tests PASS

**Step 5: Commit**

```bash
git add engine/src/pipeline/context-propagation.ts engine/tests/context-propagation.test.ts
git commit -m "feat(engine): add stageToolResults to PipelineContext and previous_stage_tool_results include option"
```

---

### Task 2: Add `previous_tool_results` to `AgentContext` and render in prompt

**Files:**
- Modify: `runner/src/prompt-builder.ts`
- Modify: `runner/tests/prompt-builder.test.ts`

**Step 1: Write failing tests**

Add to `runner/tests/prompt-builder.test.ts`, in a new describe block:

```typescript
describe('buildPrompt — previous_tool_results', () => {
  const baseAgent: AgentConfig = {
    name: 'test',
    provider: 'mock',
    model: 'mock',
    system_prompt: 'You are helpful.',
  };

  it('renders a "Previous Stage Discoveries" section per stage', () => {
    const messages = buildPrompt({
      agent: baseAgent,
      task: { description: 'Do the task.' },
      context: {
        previous_tool_results: {
          'brief-analysis': [
            {
              id: '1',
              name: 'search-search_codebase',
              arguments: { pattern: 'about' },
              result: { matches: [{ file: 'src/pages/about.tsx', content: 'export default function About' }] },
            },
          ],
        },
      },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    expect(userContent).toContain('## Previous Stage Discoveries (brief-analysis)');
    expect(userContent).toContain('search-search_codebase');
    expect(userContent).toContain('about');
    expect(userContent).toContain('about.tsx');
  });

  it('discoveries section appears before the Task section', () => {
    const messages = buildPrompt({
      agent: baseAgent,
      task: { description: 'Do the task.' },
      context: {
        previous_tool_results: {
          'stage-1': [{ id: '1', name: 'tool-x', arguments: { q: 'foo' }, result: 'bar' }],
        },
      },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    const discoveriesIdx = userContent.indexOf('## Previous Stage Discoveries');
    const taskIdx = userContent.indexOf('## Task');
    expect(discoveriesIdx).toBeGreaterThan(-1);
    expect(discoveriesIdx).toBeLessThan(taskIdx);
  });

  it('truncates results longer than 2000 chars', () => {
    const longResult = 'x'.repeat(3000);
    const messages = buildPrompt({
      agent: baseAgent,
      task: { description: 'Do the task.' },
      context: {
        previous_tool_results: {
          'stage-1': [{ id: '1', name: 'tool-x', arguments: {}, result: longResult }],
        },
      },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    expect(userContent).toContain('[truncated]');
    // Should not contain the full 3000-char result
    expect(userContent).not.toContain(longResult);
  });

  it('renders tool error when present', () => {
    const messages = buildPrompt({
      agent: baseAgent,
      task: { description: 'Do the task.' },
      context: {
        previous_tool_results: {
          'stage-1': [{ id: '1', name: 'tool-x', arguments: {}, error: 'File not found' }],
        },
      },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    expect(userContent).toContain('Error: File not found');
  });

  it('skips rendering when previous_tool_results is empty or absent', () => {
    const messages = buildPrompt({
      agent: baseAgent,
      task: { description: 'Do the task.' },
      context: {},
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    expect(userContent).not.toContain('Previous Stage Discoveries');
  });
});
```

**Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @studio-foundation/runner test
```

Expected: FAIL — `previous_tool_results` is not a recognized field, section not rendered

**Step 3: Implement changes in `runner/src/prompt-builder.ts`**

1. Add `ToolCall` import at the top of the file:
```typescript
import type { Message, AgentConfig, OutputContract, ResolvedContextPack, ToolCall } from '@studio-foundation/contracts';
```

2. Add `previous_tool_results` to `AgentContext` interface:
```typescript
export interface AgentContext {
  previous_outputs?: Record<string, unknown>;
  previous_tool_results?: Record<string, ToolCall[]>;   // ← add this
  repo_files?: string[];
  additional_context?: string;
  context_packs?: ResolvedContextPack[];
}
```

3. Add a rendering helper (at the bottom of the file, before `getFieldTypeHint`):
```typescript
const TOOL_RESULT_MAX_CHARS = 2000;

function renderToolResults(previous_tool_results: Record<string, ToolCall[]>): string {
  let out = '';
  for (const [stage, toolCalls] of Object.entries(previous_tool_results)) {
    out += `## Previous Stage Discoveries (${stage})\n\n`;
    for (const tc of toolCalls) {
      // Use first string argument value as the display label
      const label = Object.values(tc.arguments).find(v => typeof v === 'string') ?? JSON.stringify(tc.arguments);
      out += `### ${tc.name}(${label})\n`;
      if (tc.error) {
        out += `Error: ${tc.error}\n\n`;
      } else {
        const raw = JSON.stringify(tc.result, null, 2);
        const body = raw.length > TOOL_RESULT_MAX_CHARS
          ? raw.slice(0, TOOL_RESULT_MAX_CHARS) + '\n[truncated]'
          : raw;
        out += `\`\`\`\n${body}\n\`\`\`\n\n`;
      }
    }
  }
  return out;
}
```

4. In `buildPrompt`, add the rendering block **after** the `previous_outputs` block and **before** the `repo_files` block (around line 128):
```typescript
  // Add previous stage tool results if any
  if (context.previous_tool_results && Object.keys(context.previous_tool_results).length > 0) {
    userContent += renderToolResults(context.previous_tool_results);
  }
```

**Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @studio-foundation/runner test
```

Expected: all tests PASS

**Step 5: Commit**

```bash
git add runner/src/prompt-builder.ts runner/tests/prompt-builder.test.ts
git commit -m "feat(runner): add previous_tool_results to AgentContext and render as prompt discoveries section"
```

---

### Task 3: Wire engine to store tool results after each stage

**Files:**
- Modify: `engine/src/engine.ts`

No new tests needed — the unit tests for context-propagation cover the storage logic. This task is wiring.

**Step 1: Add `addStageToolResults` to the import in `engine.ts`**

Find the import from `./pipeline/context-propagation.js` (around line 43) and add `addStageToolResults`:

```typescript
import {
  createInitialContext,
  addStageOutput,
  addStageToolResults,          // ← add this
  getContextForStage,
  setGroupFeedback,
  clearGroupFeedback,
  type PipelineContext,
} from './pipeline/context-propagation.js';
```

**Step 2: Extend `StageResult` to carry tool calls**

Find the `StageResult` interface (around line 114) and add `toolCalls`:

```typescript
interface StageResult {
  stageRun: StageRun;
  status: string;
  postValidation?: PostValidationResult;
  lastAgentOutput?: unknown;
  toolCalls?: ToolCall[];           // ← add this
}
```

**Step 3: Populate `toolCalls` in `executeStage` return value**

At the bottom of `executeStage`, find the return statement (around line 527):

```typescript
    return {
      stageRun: stageRun,
      status: stageStatus,
      postValidation: postResult,
      lastAgentOutput: lastResult?.output,
      toolCalls: lastResult?.tool_calls,    // ← add this
    };
```

**Step 4: Store tool results for simple stages in `run()`**

In `run()`, find the block that calls `addStageOutput` for simple stages (around line 268):

```typescript
        if (result.lastAgentOutput !== undefined) {
          addStageOutput(pipelineContext, entry.name, result.lastAgentOutput);
        }
```

Add the tool results storage right after it:

```typescript
        if (result.lastAgentOutput !== undefined) {
          addStageOutput(pipelineContext, entry.name, result.lastAgentOutput);
        }
        if (result.toolCalls && result.toolCalls.length > 0) {
          addStageToolResults(pipelineContext, entry.name, result.toolCalls);
        }
```

**Step 5: Store tool results for group stages in `runGroup()`**

In `runGroup()`, find the block that calls `addStageOutput` (around line 620):

```typescript
        if (result.lastAgentOutput !== undefined) {
          addStageOutput(context, stage.name, result.lastAgentOutput);
        }
```

Add after it:

```typescript
        if (result.lastAgentOutput !== undefined) {
          addStageOutput(context, stage.name, result.lastAgentOutput);
        }
        if (result.toolCalls && result.toolCalls.length > 0) {
          addStageToolResults(context, stage.name, result.toolCalls);
        }
```

**Step 6: Build and run all tests**

```bash
cd /home/arianeguay/dev/src/Studio && pnpm build && pnpm test
```

Expected: build succeeds, all tests pass

**Step 7: Commit**

```bash
git add engine/src/engine.ts
git commit -m "feat(engine): store stage tool results in PipelineContext after each stage"
```

---

### Task 4: Update pipeline YAMLs to opt in

**Files:**
- Modify: `cli/templates/projects/software-full/pipelines/feature-builder.pipeline.yaml`
- Modify: `cli/templates/projects/software/pipelines/feature-builder.pipeline.yaml`
- Modify: `/home/arianeguay/dev/src/studio-sandbox/code-builder/.studio/pipelines/feature-builder.pipeline.yaml`

**Step 1: Update `implementation-plan` stage in all three files**

In the `implementation-plan` stage, change:

```yaml
    context:
      include:
        - input
        - previous_stage_output
```

To:

```yaml
    context:
      include:
        - input
        - previous_stage_output
        - previous_stage_tool_results
```

**Step 2: Update `code-generation` stage to use `all_stage_tool_results`**

In the `code-generation` stage (inside `implementation-review` group), change:

```yaml
        context:
          include:
            - input
            - all_stage_outputs
            - group_feedback
```

To:

```yaml
        context:
          include:
            - input
            - all_stage_outputs
            - all_stage_tool_results
            - group_feedback
```

**Step 3: Build and confirm no errors**

```bash
cd /home/arianeguay/dev/src/Studio && pnpm build
```

Expected: PASS

**Step 4: Commit**

```bash
git add cli/templates/projects/software-full/pipelines/feature-builder.pipeline.yaml
git add cli/templates/projects/software/pipelines/feature-builder.pipeline.yaml
git add /home/arianeguay/dev/src/studio-sandbox/code-builder/.studio/pipelines/feature-builder.pipeline.yaml
git commit -m "feat(templates): enable tool result context propagation in feature-builder pipeline"
```

---

### Task 5: Smoke test end-to-end

**Step 1: Run the sandbox pipeline and observe no redundant searches**

```bash
cd /home/arianeguay/dev/src/studio-sandbox/code-builder
studio run feature-builder --input-file .studio/inputs/faq-about.input.yaml --live
```

**Expected:** Stage 2 (`implementation-plan`) should NOT repeat searches that stage 1 (`brief-analysis`) already made. The agent should reference existing discoveries instead of re-running `search-search_codebase` with identical queries.

**Step 2: If stage 2 still searches, check that tool results appear in the prompt**

Add a temporary `DEBUG=studio:*` to see what's being sent:

```bash
DEBUG=studio:* studio run feature-builder --input-file .studio/inputs/faq-about.input.yaml --live 2>&1 | head -200
```

Look for `## Previous Stage Discoveries (brief-analysis)` in the logged prompt.
