# STU-94: Lifecycle Hooks Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add YAML-configurable lifecycle hooks (`on_stage_start`, `on_stage_complete`, `pre_tool_use`, `post_tool_use`) to pipeline stage definitions, enabling deterministic shell commands at execution lifecycle points.

**Architecture:** Hooks are defined in `StageDefinition` (pipeline.yaml). The engine owns all hook execution via a new `hook-executor.ts` module. Stage-level hooks (`on_stage_start`, `on_stage_complete`) are called directly in `executeStage()`. Tool-level hooks (`pre_tool_use`, `post_tool_use`) are wired via two new `RunnerCallbacks` (`onPreToolUse`, `onPostToolUse`) that the runner honors to block or annotate tool calls.

**Tech Stack:** TypeScript, Vitest, Node.js `child_process.exec`, `pnpm` workspaces.

**Design doc:** `docs/plans/2026-02-21-stu-94-lifecycle-hooks-design.md`

---

### Task 1: Add hook types to contracts

**Files:**
- Modify: `contracts/src/pipeline.ts`
- Modify: `contracts/src/runner-events.ts`

**Step 1: Add hook types to pipeline.ts**

Add to the bottom of `contracts/src/pipeline.ts`, before the `StageDefinition` interface extension:

```typescript
// Lifecycle hooks — configurable shell commands at stage/tool lifecycle points

export type HookOnFailure = 'warn' | 'reject' | 'fail';

export interface StageHookDef {
  command: string;
  on_failure?: HookOnFailure;  // default: 'warn'
}

export interface ToolHookDef {
  matcher: string;             // exact tool name to match (e.g. "repo_manager-write_file")
  command: string;
  on_failure?: HookOnFailure;  // default: 'warn'
}

export interface StageHooks {
  on_stage_start?: StageHookDef[];
  on_stage_complete?: StageHookDef[];
  pre_tool_use?: ToolHookDef[];
  post_tool_use?: ToolHookDef[];
}
```

Then add `hooks?: StageHooks;` to the `StageDefinition` interface (after the `tools?` field).

**Step 2: Add new callbacks to runner-events.ts**

Add to `contracts/src/runner-events.ts`, at the bottom of `RunnerCallbacks`:

```typescript
  /**
   * Called before tool execution. Return { blocked: true, error } to prevent the tool from running.
   * The error is surfaced as the tool result so the LLM can react and RALPH loop continues.
   */
  onPreToolUse?: (event: {
    tool: string;
    params: Record<string, unknown>;
    timestamp: number;
  }) => Promise<{ blocked: boolean; error?: string }>;

  /**
   * Called after tool execution (only if the tool was not blocked).
   * Return { append_message } to inject a note into the conversation after the tool result.
   * Only effective in the standard (Chat Completions) provider path.
   */
  onPostToolUse?: (event: {
    tool: string;
    params: Record<string, unknown>;
    result: unknown;
    error?: string;
    timestamp: number;
  }) => Promise<{ append_message?: string }>;
```

**Step 3: Build to verify TypeScript**

```bash
pnpm build
```

Expected: build passes, no type errors.

**Step 4: Commit**

```bash
git add contracts/src/pipeline.ts contracts/src/runner-events.ts
git commit -m "feat(contracts): add StageHooks types and onPreToolUse/onPostToolUse callbacks"
```

---

### Task 2: Create hook-executor.ts

**Files:**
- Create: `engine/src/pipeline/hook-executor.ts`
- Create: `engine/src/pipeline/hook-executor.test.ts`

**Step 1: Write the failing tests**

Create `engine/src/pipeline/hook-executor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { renderHookCommand, runStageHook, runToolHook } from './hook-executor.js';

describe('renderHookCommand', () => {
  it('substitutes {{tool.argName}} with tool argument value', () => {
    const result = renderHookCommand(
      'npx prettier --write {{tool.path}}',
      { path: '/tmp/foo.ts' }
    );
    expect(result).toBe('npx prettier --write /tmp/foo.ts');
  });

  it('returns empty string for missing tool argument', () => {
    const result = renderHookCommand('do something {{tool.missing}}', {});
    expect(result).toBe('do something ');
  });

  it('substitutes multiple occurrences of the same placeholder', () => {
    const result = renderHookCommand('cp {{tool.src}} {{tool.dst}}', { src: 'a.ts', dst: 'b.ts' });
    expect(result).toBe('cp a.ts b.ts');
  });

  it('leaves non-tool placeholders unchanged', () => {
    const result = renderHookCommand('echo {{other}}', { other: 'x' });
    // {{other}} is not a {{tool.*}} pattern — left as-is
    expect(result).toBe('echo {{other}}');
  });
});

describe('runStageHook', () => {
  it('returns success with stdout when command exits 0', async () => {
    const result = await runStageHook(
      { command: 'echo hello', on_failure: 'warn' },
      '/tmp'
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('hello');
    expect(result.stderr).toBe('');
  });

  it('returns failure with stderr when command exits non-zero', async () => {
    const result = await runStageHook(
      { command: 'sh -c "echo boom >&2; exit 1"', on_failure: 'warn' },
      '/tmp'
    );
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('boom');
  });
});

describe('runToolHook', () => {
  it('renders template and executes command', async () => {
    const result = await runToolHook(
      { matcher: 'repo_manager-write_file', command: 'echo {{tool.path}}', on_failure: 'warn' },
      { path: '/tmp/test.ts' },
      '/tmp'
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('/tmp/test.ts');
  });

  it('returns failure when rendered command exits non-zero', async () => {
    const result = await runToolHook(
      { matcher: 'any-tool', command: 'exit 1', on_failure: 'warn' },
      {},
      '/tmp'
    );
    expect(result.success).toBe(false);
  });
});
```

**Step 2: Run to verify they fail**

```bash
pnpm --filter @studio-foundation/engine test -- hook-executor
```

Expected: FAIL — `runStageHook`, `renderHookCommand`, `runToolHook` not found.

**Step 3: Implement hook-executor.ts**

Create `engine/src/pipeline/hook-executor.ts`:

```typescript
// Hook executor — runs shell commands at lifecycle points within a stage
// Mirrors startup-executor.ts but with on_failure semantics and tool arg templates

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { StageHookDef, ToolHookDef } from '@studio-foundation/contracts';

const execAsync = promisify(exec);
const HOOK_TIMEOUT_MS = 30_000;

export interface HookResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Renders {{tool.argName}} placeholders from tool call arguments.
 * Only substitutes {{tool.<word>}} patterns — other placeholders are left unchanged.
 * Unknown args → empty string.
 */
export function renderHookCommand(
  command: string,
  toolArgs: Record<string, unknown>
): string {
  return command.replace(
    /\{\{tool\.(\w+)\}\}/g,
    (_, key: string) => (toolArgs[key] !== undefined ? String(toolArgs[key]) : '')
  );
}

/**
 * Run a stage-level hook command (on_stage_start, on_stage_complete).
 */
export async function runStageHook(
  hook: StageHookDef,
  cwd: string
): Promise<HookResult> {
  return execHook(hook.command, cwd);
}

/**
 * Run a tool-level hook command (pre_tool_use, post_tool_use).
 * The command may reference tool arguments via {{tool.argName}}.
 */
export async function runToolHook(
  hook: ToolHookDef,
  toolArgs: Record<string, unknown>,
  cwd: string
): Promise<HookResult> {
  const command = renderHookCommand(hook.command, toolArgs);
  return execHook(command, cwd);
}

async function execHook(command: string, cwd: string): Promise<HookResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: HOOK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 10,
    });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return {
      success: false,
      stdout: e.stdout?.trim() ?? '',
      stderr: e.stderr?.trim() ?? String(err),
    };
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio-foundation/engine test -- hook-executor
```

Expected: all 7 tests PASS.

**Step 5: Commit**

```bash
git add engine/src/pipeline/hook-executor.ts engine/src/pipeline/hook-executor.test.ts
git commit -m "feat(engine): add hook-executor — shell execution with {{tool.arg}} templates"
```

---

### Task 3: Parse hooks from stage YAML in loader.ts

**Files:**
- Modify: `engine/src/pipeline/loader.ts`
- Modify: `engine/src/pipeline/loader.test.ts`

**Step 1: Write the failing tests**

Add a new `describe` block to `engine/src/pipeline/loader.test.ts`:

```typescript
const PIPELINE_WITH_HOOKS = `
name: test-pipeline
description: test
version: 1
stages:
  - name: code-gen
    kind: code
    agent: coder
    hooks:
      on_stage_start:
        - command: "git stash"
          on_failure: warn
      on_stage_complete:
        - command: "npx tsc --noEmit"
          on_failure: reject
      pre_tool_use:
        - matcher: "repo_manager-write_file"
          command: "echo pre {{tool.path}}"
          on_failure: warn
      post_tool_use:
        - matcher: "repo_manager-write_file"
          command: "npx prettier --write {{tool.path}}"
          on_failure: warn
`;

describe('parsePipelineYaml — stage hooks', () => {
  it('parses all four hook types from a stage', () => {
    const result = parsePipelineYaml(PIPELINE_WITH_HOOKS);
    const stage = result.stages[0] as StageDefinition;
    expect(stage.hooks?.on_stage_start).toEqual([
      { command: 'git stash', on_failure: 'warn' },
    ]);
    expect(stage.hooks?.on_stage_complete).toEqual([
      { command: 'npx tsc --noEmit', on_failure: 'reject' },
    ]);
    expect(stage.hooks?.pre_tool_use).toEqual([
      { matcher: 'repo_manager-write_file', command: 'echo pre {{tool.path}}', on_failure: 'warn' },
    ]);
    expect(stage.hooks?.post_tool_use).toEqual([
      { matcher: 'repo_manager-write_file', command: 'npx prettier --write {{tool.path}}', on_failure: 'warn' },
    ]);
  });

  it('returns undefined hooks when stage has no hooks', () => {
    const yaml = `
name: test-pipeline
description: test
version: 1
stages:
  - name: analyze
    kind: analysis
    agent: analyst
`;
    const result = parsePipelineYaml(yaml);
    const stage = result.stages[0] as StageDefinition;
    expect(stage.hooks).toBeUndefined();
  });
});
```

Add `StageDefinition` to the import from the loader.

**Step 2: Run to verify they fail**

```bash
pnpm --filter @studio-foundation/engine test -- loader
```

Expected: FAIL — hooks is undefined.

**Step 3: Implement hook parsing in loader.ts**

In `engine/src/pipeline/loader.ts`, the `parsePipelineYaml` function pushes stages via `stages.push(entry as StageDefinition)`. The `entry` object from YAML already contains the `hooks` key if present, so it will be preserved.

However, the loader needs to also parse stages inside groups. Currently both paths just cast the raw entry. The simplest fix: ensure `hooks` is explicitly parsed for validation-friendliness.

Add a `parseStageHooks` helper at the bottom of loader.ts (before `validateStageFields`):

```typescript
function parseStageHooks(entry: any): StageHooks | undefined {
  if (!entry.hooks || typeof entry.hooks !== 'object') return undefined;
  const h = entry.hooks;
  const result: StageHooks = {};

  if (Array.isArray(h.on_stage_start)) {
    result.on_stage_start = h.on_stage_start.map((hk: any) => ({
      command: String(hk.command ?? ''),
      on_failure: hk.on_failure ?? 'warn',
    }));
  }
  if (Array.isArray(h.on_stage_complete)) {
    result.on_stage_complete = h.on_stage_complete.map((hk: any) => ({
      command: String(hk.command ?? ''),
      on_failure: hk.on_failure ?? 'warn',
    }));
  }
  if (Array.isArray(h.pre_tool_use)) {
    result.pre_tool_use = h.pre_tool_use.map((hk: any) => ({
      matcher: String(hk.matcher ?? ''),
      command: String(hk.command ?? ''),
      on_failure: hk.on_failure ?? 'warn',
    }));
  }
  if (Array.isArray(h.post_tool_use)) {
    result.post_tool_use = h.post_tool_use.map((hk: any) => ({
      matcher: String(hk.matcher ?? ''),
      command: String(hk.command ?? ''),
      on_failure: hk.on_failure ?? 'warn',
    }));
  }

  const hasAny = result.on_stage_start || result.on_stage_complete
    || result.pre_tool_use || result.post_tool_use;
  return hasAny ? result : undefined;
}
```

Also add `StageHooks` to the import from `@studio-foundation/contracts`.

Then apply in the loop where stages are pushed. Change the simple stage push from:
```typescript
stages.push(entry as StageDefinition);
```
to:
```typescript
stages.push({ ...entry, hooks: parseStageHooks(entry) } as StageDefinition);
```

And for group stages, change:
```typescript
stages: entry.stages,
```
to:
```typescript
stages: entry.stages.map((s: any) => ({ ...s, hooks: parseStageHooks(s) })),
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio-foundation/engine test -- loader
```

Expected: all loader tests PASS (including new hooks tests).

**Step 5: Build to verify no TypeScript errors**

```bash
pnpm build
```

**Step 6: Commit**

```bash
git add engine/src/pipeline/loader.ts engine/src/pipeline/loader.test.ts
git commit -m "feat(engine): parse lifecycle hooks from stage YAML"
```

---

### Task 4: Honor onPreToolUse and onPostToolUse in runner.ts

**Files:**
- Modify: `runner/src/runner.ts`
- Create: `runner/src/runner.test.ts`

**Step 1: Write the failing tests**

Create `runner/src/runner.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { runAgent } from './runner.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { ProviderRegistry } from './providers/registry.js';
import { MockProvider } from './providers/mock.js';
import type { AgentConfig } from '@studio-foundation/contracts';

function makeConfig(toolCallName: string, toolCallArgs: Record<string, unknown>) {
  const toolRegistry = new ToolRegistry();
  const mockExecute = vi.fn().mockResolvedValue({ success: true, output: 'wrote file' });
  toolRegistry.register({
    name: toolCallName,
    description: 'A test tool',
    parameters: {
      type: 'object',
      properties: Object.fromEntries(
        Object.keys(toolCallArgs).map(k => [k, { type: 'string' }])
      ),
    },
    execute: mockExecute,
  });

  const mockProvider = new MockProvider(
    new Map([
      ['test-stage', {
        output: { summary: 'done' },
        tool_calls: [{ name: toolCallName, arguments: toolCallArgs }],
      }],
    ])
  );

  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(mockProvider);

  const agent: AgentConfig = {
    name: 'test-agent',
    provider: 'mock',
    model: 'mock',
  };

  return { agent, toolRegistry, providerRegistry, mockExecute };
}

describe('runner — onPreToolUse callback', () => {
  it('blocks tool execution when callback returns blocked: true', async () => {
    const { agent, toolRegistry, providerRegistry, mockExecute } = makeConfig(
      'repo_manager-write_file',
      { path: '/tmp/foo.ts', content: 'hello' }
    );

    const onPreToolUse = vi.fn().mockResolvedValue({ blocked: true, error: 'pre-hook blocked' });

    const result = await runAgent({
      agent,
      task: { description: 'write a file', contract_name: 'test-stage' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: { onPreToolUse },
    });

    // Tool should appear in tool_calls with error (not actually executed)
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].error).toContain('pre-hook blocked');
    expect(result.tool_calls[0].result).toBeUndefined();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('allows tool execution when callback returns blocked: false', async () => {
    const { agent, toolRegistry, providerRegistry, mockExecute } = makeConfig(
      'repo_manager-write_file',
      { path: '/tmp/foo.ts', content: 'hello' }
    );

    const onPreToolUse = vi.fn().mockResolvedValue({ blocked: false });

    const result = await runAgent({
      agent,
      task: { description: 'write a file', contract_name: 'test-stage' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: { onPreToolUse },
    });

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].result).toBe('wrote file');
    expect(mockExecute).toHaveBeenCalledOnce();
  });
});

describe('runner — onPostToolUse callback', () => {
  it('is called after successful tool execution', async () => {
    const { agent, toolRegistry, providerRegistry } = makeConfig(
      'repo_manager-write_file',
      { path: '/tmp/foo.ts', content: 'hello' }
    );

    const onPostToolUse = vi.fn().mockResolvedValue({});

    await runAgent({
      agent,
      task: { description: 'write a file', contract_name: 'test-stage' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: { onPostToolUse },
    });

    expect(onPostToolUse).toHaveBeenCalledOnce();
    expect(onPostToolUse.mock.calls[0][0]).toMatchObject({
      tool: 'repo_manager-write_file',
      params: { path: '/tmp/foo.ts', content: 'hello' },
      result: 'wrote file',
    });
  });

  it('appends hook message to conversation when returned (standard path — no-op in agent loop)', async () => {
    // The MockProvider uses the agent loop path, so append_message is a no-op here.
    // This test verifies onPostToolUse IS called and no error is thrown.
    const { agent, toolRegistry, providerRegistry } = makeConfig(
      'repo_manager-write_file',
      { path: '/tmp/foo.ts', content: 'hello' }
    );

    const onPostToolUse = vi.fn().mockResolvedValue({
      append_message: 'prettier ran successfully',
    });

    const result = await runAgent({
      agent,
      task: { description: 'write a file', contract_name: 'test-stage' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: { onPostToolUse },
    });

    expect(onPostToolUse).toHaveBeenCalled();
    // Result still succeeds
    expect(result.tool_calls_count).toBe(1);
  });
});
```

**Step 2: Run to verify they fail**

```bash
pnpm --filter @studio-foundation/runner test -- runner.test
```

Expected: FAIL — `onPreToolUse` is not called, tool executes anyway.

**Step 3: Implement pre/post hooks in runner.ts**

Two code paths to modify: the **agent loop path** and the **standard multi-turn path**.

**Agent loop path** (around line 108 in runner.ts, inside the `provider.runAgentLoop(...)` callback):

```typescript
async (name, args, callId) => {
  const tcStart = Date.now();
  config.callbacks?.onToolCallStart?.({
    tool: name,
    params: args,
    timestamp: tcStart,
  });

  // pre_tool_use: check if hook wants to block this tool call
  if (config.callbacks?.onPreToolUse) {
    const preResult = await config.callbacks.onPreToolUse({ tool: name, params: args, timestamp: tcStart });
    if (preResult.blocked) {
      const blockedCall: ToolCall = {
        id: callId,
        name,
        arguments: args,
        error: preResult.error ?? 'Pre-tool hook blocked execution',
      };
      allToolCalls.push(blockedCall);
      return { result: undefined, error: blockedCall.error };
    }
  }

  const executed = await toolExecutor.execute({ id: callId, name, arguments: args });
  allToolCalls.push(executed);

  config.callbacks?.onToolCallComplete?.({
    tool: name,
    result: executed.result,
    error: executed.error,
    duration_ms: Date.now() - tcStart,
    timestamp: Date.now(),
  });

  // post_tool_use: notify engine (append_message not injected in agent loop path)
  if (config.callbacks?.onPostToolUse) {
    await config.callbacks.onPostToolUse({
      tool: name,
      params: args,
      result: executed.result,
      error: executed.error,
      timestamp: Date.now(),
    });
  }

  // Anonymize tool result before returning to provider
  let result = executed.result;
  if (mw && result !== undefined) {
    const resultStr = mw.anonymize(JSON.stringify(result));
    try { result = JSON.parse(resultStr); } catch { result = resultStr; }
  }
  return { result, error: executed.error };
},
```

**Standard multi-turn path** (around line 204 in runner.ts, inside the `for (const tc of response.tool_calls)` loop):

Replace the existing loop body with:

```typescript
const executedToolCalls: ToolCall[] = [];
const appendMessages = new Map<string, string>(); // tc.id → post-hook message

for (const tc of response.tool_calls) {
  const tcStart = Date.now();
  config.callbacks?.onToolCallStart?.({
    tool: tc.name,
    params: tc.arguments,
    timestamp: tcStart,
  });

  // pre_tool_use: check if hook wants to block this tool call
  let executed: ToolCall;
  let wasBlocked = false;
  if (config.callbacks?.onPreToolUse) {
    const preResult = await config.callbacks.onPreToolUse({
      tool: tc.name,
      params: tc.arguments,
      timestamp: tcStart,
    });
    if (preResult.blocked) {
      wasBlocked = true;
      executed = {
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        error: preResult.error ?? 'Pre-tool hook blocked execution',
      };
    }
  }

  if (!wasBlocked) {
    executed = await toolExecutor.execute({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    });
  }

  executedToolCalls.push(executed!);
  allToolCalls.push(executed!);

  config.callbacks?.onToolCallComplete?.({
    tool: tc.name,
    result: executed!.result,
    error: executed!.error,
    duration_ms: Date.now() - tcStart,
    timestamp: Date.now(),
  });

  // post_tool_use: only called if tool was not blocked
  if (!wasBlocked && config.callbacks?.onPostToolUse) {
    const postResult = await config.callbacks.onPostToolUse({
      tool: tc.name,
      params: tc.arguments,
      result: executed!.result,
      error: executed!.error,
      timestamp: Date.now(),
    });
    if (postResult.append_message) {
      appendMessages.set(tc.id, postResult.append_message);
    }
  }
}
```

Then update the `toolResultsMessage` builder (a few lines below) to include append messages:

```typescript
const toolResultsMessage = executedToolCalls.map(tc => {
  let msg: string;
  if (tc.error) {
    msg = `Tool ${tc.name} (id: ${tc.id}) failed: ${tc.error}`;
  } else {
    msg = `Tool ${tc.name} (id: ${tc.id}) result: ${JSON.stringify(tc.result)}`;
  }
  const appendMsg = appendMessages.get(tc.id);
  if (appendMsg) {
    msg += `\n\nPost-hook note: ${appendMsg}`;
  }
  return msg;
}).join('\n\n');
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio-foundation/runner test -- runner.test
```

Expected: all 4 tests PASS.

**Step 5: Build**

```bash
pnpm build
```

**Step 6: Commit**

```bash
git add runner/src/runner.ts runner/src/runner.test.ts
git commit -m "feat(runner): honor onPreToolUse (block) and onPostToolUse callbacks"
```

---

### Task 5: Integrate hooks into engine.ts executeStage()

**Files:**
- Modify: `engine/src/engine.ts`

This task integrates the hook executor into the stage lifecycle. No new test file — the hook executor is already tested. We verify the engine change works via a build check and by reading the code.

**Step 1: Add imports to engine.ts**

At the top of `engine/src/engine.ts`, add:

```typescript
import { runStageHook, runToolHook } from './pipeline/hook-executor.js';
import type { StageHooks, ToolHookDef } from '@studio-foundation/contracts';
```

**Step 2: Add on_stage_start hook execution**

In `executeStage()`, after the agent config is loaded and before the ralph loop (around the line where `taskRun` is created), add:

```typescript
// Run on_stage_start hooks before the ralph loop
const stageHooks = stageDef.hooks;
const hookCwd = this.config.repoPath ?? this.config.configsDir;

if (stageHooks?.on_stage_start?.length) {
  for (const hook of stageHooks.on_stage_start) {
    const hookResult = await runStageHook(hook, hookCwd);
    if (!hookResult.success) {
      const onFailure = hook.on_failure ?? 'warn';
      if (onFailure === 'fail') {
        stageRun.status = 'failed';
        stageRun.completed_at = new Date().toISOString();
        stageRun.tasks = [];
        this.events?.onStageComplete?.({
          stage_name: stageDef.name,
          stage_index: stageIndex,
          total_stages: totalStages,
          status: 'failed',
          attempts: 0,
          duration_ms: 0,
        });
        return { stageRun, status: 'failed' };
      } else if (onFailure === 'reject') {
        stageRun.status = 'rejected';
        stageRun.completed_at = new Date().toISOString();
        stageRun.tasks = [];
        this.events?.onStageComplete?.({
          stage_name: stageDef.name,
          stage_index: stageIndex,
          total_stages: totalStages,
          status: 'rejected',
          attempts: 0,
          duration_ms: 0,
        });
        return {
          stageRun,
          status: 'rejected',
          postValidation: {
            accepted: false,
            rejection_reason: `on_stage_start hook failed: ${hook.command}`,
            rejection_details: hookResult.stderr ? [hookResult.stderr] : [],
          },
        };
      } else {
        // warn (default)
        console.warn(`[on_stage_start] hook failed for stage "${stageDef.name}": ${hookResult.stderr}`);
      }
    }
  }
}
```

**Step 3: Build pre/post tool use callbacks for runAgent**

In `executeStage()`, when building the callbacks for `runAgent()`, add `onPreToolUse` and `onPostToolUse`:

```typescript
const onPreToolUse = stageHooks?.pre_tool_use?.length
  ? async (event: { tool: string; params: Record<string, unknown>; timestamp: number }) => {
      const matchingHooks = stageHooks!.pre_tool_use!.filter(h => h.matcher === event.tool);
      for (const hook of matchingHooks) {
        const hookResult = await runToolHook(hook, event.params, hookCwd);
        if (!hookResult.success) {
          return { blocked: true, error: `Pre-hook failed: ${hookResult.stderr || hookResult.stdout}` };
        }
      }
      return { blocked: false };
    }
  : undefined;

const onPostToolUse = stageHooks?.post_tool_use?.length
  ? async (event: { tool: string; params: Record<string, unknown>; result: unknown; error?: string; timestamp: number }) => {
      const matchingHooks = stageHooks!.post_tool_use!.filter(h => h.matcher === event.tool);
      for (const hook of matchingHooks) {
        const hookResult = await runToolHook(hook, event.params, hookCwd);
        if (!hookResult.success) {
          const onFailure = hook.on_failure ?? 'warn';
          if (onFailure === 'reject') {
            const msg = hookResult.stderr || 'post-hook failed';
            return { append_message: `Post-hook failed: ${msg}` };
          } else {
            console.warn(`[post_tool_use] hook failed for "${event.tool}" in stage "${stageDef.name}": ${hookResult.stderr}`);
          }
        }
      }
      return {};
    }
  : undefined;
```

Then pass these into the `callbacks` object in `runAgent()`. The callbacks object currently looks like:

```typescript
callbacks: this.events ? {
  onToolCallStart: this.events.onToolCallStart,
  onToolCallComplete: this.events.onToolCallComplete,
  onAgentThinking: ...,
  onAgentProgress: ...,
  onAgentToken: ...,
} : undefined,
```

Update it to always include hook callbacks when present (even if `this.events` is undefined):

```typescript
callbacks: {
  ...(this.events ? {
    onToolCallStart: this.events.onToolCallStart,
    onToolCallComplete: this.events.onToolCallComplete,
    onAgentThinking: this.events.onAgentThinking
      ? (e) => this.events!.onAgentThinking!({ stage: stageDef.name, ...e })
      : undefined,
    onAgentProgress: this.events.onAgentProgress
      ? (e) => this.events!.onAgentProgress!({ stage: stageDef.name, ...e })
      : undefined,
    onAgentToken: this.events.onAgentToken
      ? (e) => this.events!.onAgentToken!({ stage: stageDef.name, ...e })
      : undefined,
  } : {}),
  ...(onPreToolUse ? { onPreToolUse } : {}),
  ...(onPostToolUse ? { onPostToolUse } : {}),
},
```

**Step 4: Add on_stage_complete hook execution**

After the `postValidate()` block (after `stageStatus` may have been overridden to 'rejected'), add:

```typescript
// Run on_stage_complete hooks — only when stage succeeded (including post-validation)
if (stageStatus === 'success' && stageHooks?.on_stage_complete?.length) {
  for (const hook of stageHooks.on_stage_complete) {
    const hookResult = await runStageHook(hook, hookCwd);
    if (!hookResult.success) {
      const onFailure = hook.on_failure ?? 'warn';
      if (onFailure === 'reject') {
        stageStatus = 'rejected';
        postResult = {
          accepted: false,
          rejection_reason: `on_stage_complete hook failed: ${hook.command}`,
          rejection_details: hookResult.stderr ? [hookResult.stderr] : [],
        };
        break;
      } else if (onFailure === 'fail') {
        stageStatus = 'failed';
        break;
      } else {
        // warn (default)
        console.warn(`[on_stage_complete] hook failed for stage "${stageDef.name}": ${hookResult.stderr}`);
      }
    }
  }
}
```

**Step 5: Build**

```bash
pnpm build
```

Expected: build passes, no TypeScript errors.

**Step 6: Run all tests**

```bash
pnpm test
```

Expected: all tests PASS.

**Step 7: Commit**

```bash
git add engine/src/engine.ts
git commit -m "feat(engine): integrate lifecycle hooks into executeStage (STU-94)"
```

---

### Task 6: Verify acceptance criteria manually

**Step 1: Check that STU-91 is covered**

In a user's pipeline.yaml, the `on_stage_complete` tsc hook would look like:

```yaml
hooks:
  on_stage_complete:
    - command: "npx tsc --noEmit"
      on_failure: reject
```

Verify in `hook-executor.test.ts` that a non-zero exit command returns `{ success: false, stderr: "..." }`. ✓ (Already tested.)

**Step 2: Check prettier auto-run**

In a user's pipeline.yaml, the prettier hook would look like:

```yaml
hooks:
  post_tool_use:
    - matcher: "repo_manager-write_file"
      command: "npx prettier --write {{tool.path}}"
      on_failure: warn
```

Verify `renderHookCommand('npx prettier --write {{tool.path}}', { path: '/tmp/foo.ts' })` returns the correct command. ✓ (Already tested.)

**Step 3: Final build + test run**

```bash
pnpm build && pnpm test
```

Expected: all green.

**Step 4: Commit if not already done, then push for PR**

```bash
git log --oneline -5  # review commits
```

---

### Acceptance Criteria Checklist

- [ ] `on_stage_complete` with `on_failure: reject` → `npx tsc --noEmit` failure causes stage `rejected` status
- [ ] `post_tool_use` on `repo_manager-write_file` → prettier runs automatically with `{{tool.path}}` substitution
- [ ] Hook errors with `on_failure: reject` are injected via `setGroupFeedback` (via synthetic `postValidation`) so the coder receives them in `group_feedback`
- [ ] All 4 hook types (`on_stage_start`, `on_stage_complete`, `pre_tool_use`, `post_tool_use`) work
- [ ] `pnpm build && pnpm test` passes
