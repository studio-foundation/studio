# Live Streaming Tool Calls (`--live`) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `--live` flag to `studio run` that streams each tool call to the terminal in real time with a spinner, as the agent executes it.

**Architecture:** Extend `EngineEvents` with `onToolCallStart`/`onToolCallComplete` callbacks. Define the shared event types and a `RunnerCallbacks` interface in `@studio/contracts` (the leaf package, importable by all layers). Thread callbacks from CLI → engine → `runAgent()` → tool executor. `ProgressDisplay` gains a `displayMode` replacing the `verbose` boolean, with a new `'live'` mode that renders per-tool spinners.

**Tech Stack:** TypeScript, vitest, ora (spinners), chalk (colors). pnpm workspaces monorepo — run `pnpm build` from repo root after touching multiple packages.

---

### Task 1: Add event types to `@studio/contracts`

**Files:**
- Create: `contracts/src/runner-events.ts`
- Modify: `contracts/src/index.ts`

No test needed — these are pure TypeScript types; correctness is enforced by downstream type-checking.

**Step 1: Create `contracts/src/runner-events.ts`**

```typescript
/**
 * Event types for real-time tool call streaming.
 * Defined in contracts (leaf package) so runner can import them
 * without creating an inverse dependency on engine.
 */

export interface ToolCallStartEvent {
  tool: string;
  params: Record<string, unknown>;
  timestamp: string;
}

export interface ToolCallCompleteEvent {
  tool: string;
  result: unknown;
  error?: string;
  duration_ms: number;
  timestamp: string;
}

/**
 * Subset of callbacks the runner accepts for real-time event emission.
 * Engine populates these from EngineEvents and passes them to runAgent().
 */
export interface RunnerCallbacks {
  onToolCallStart?: (event: ToolCallStartEvent) => void;
  onToolCallComplete?: (event: ToolCallCompleteEvent) => void;
}
```

**Step 2: Export from `contracts/src/index.ts`**

Add at the end of the file:

```typescript
export * from './runner-events.js';
```

**Step 3: Build to verify no errors**

```bash
cd /path/to/Studio && pnpm build
```

Expected: build succeeds.

**Step 4: Commit**

```bash
git add contracts/src/runner-events.ts contracts/src/index.ts
git commit -m "feat(contracts): add ToolCallStartEvent, ToolCallCompleteEvent, RunnerCallbacks"
```

---

### Task 2: Extend `EngineEvents` with tool call callbacks

**Files:**
- Modify: `engine/src/events.ts`

No test needed — pure type extension.

**Step 1: Add imports and new callbacks to `engine/src/events.ts`**

At the top of the file, add the import:

```typescript
import type { ToolCallStartEvent, ToolCallCompleteEvent } from '@studio/contracts';
```

Add two new optional fields to the `EngineEvents` interface (after `onGroupComplete`):

```typescript
export interface EngineEvents {
  onPipelineStart?: (event: PipelineStartEvent) => void;
  onPipelineComplete?: (event: PipelineCompleteEvent) => void;
  onStageStart?: (event: StageStartEvent) => void;
  onStageComplete?: (event: StageCompleteEvent) => void;
  onTaskRetry?: (event: StageRetryEvent) => void;
  onGroupStart?: (event: GroupStartEvent) => void;
  onGroupIteration?: (event: GroupIterationEvent) => void;
  onGroupFeedback?: (event: GroupFeedbackEvent) => void;
  onGroupComplete?: (event: GroupCompleteEvent) => void;
  // Real-time tool call streaming (used by --live mode)
  onToolCallStart?: (event: ToolCallStartEvent) => void;
  onToolCallComplete?: (event: ToolCallCompleteEvent) => void;
}
```

**Step 2: Build to verify**

```bash
pnpm build
```

Expected: succeeds.

**Step 3: Commit**

```bash
git add engine/src/events.ts
git commit -m "feat(engine): add onToolCallStart/Complete to EngineEvents"
```

---

### Task 3: Runner — callbacks in the standard multi-turn path (TDD)

**Files:**
- Modify: `runner/src/runner.ts`
- Modify: `runner/tests/runner.test.ts`

**Step 1: Write the failing test**

In `runner/tests/runner.test.ts`, add a new `describe` block after the existing ones:

```typescript
describe('runAgent — callbacks', () => {
  it('calls onToolCallStart and onToolCallComplete for each tool call', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'echo_tool',
      description: 'Echoes input',
      parameters: {},
      execute: async (args) => ({ success: true, output: args }),
    });

    const mockProvider = new MockProvider([
      {
        content: '',
        tool_calls: [{ id: 'tc-1', name: 'echo_tool', arguments: { msg: 'hello' } }],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        content: '"done"',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
    ]);

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);

    const startEvents: import('@studio/contracts').ToolCallStartEvent[] = [];
    const completeEvents: import('@studio/contracts').ToolCallCompleteEvent[] = [];

    await runAgent({
      agent: { name: 'test-agent', provider: 'mock', model: 'test-model' },
      task: { description: 'Test callbacks' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: {
        onToolCallStart: (e) => startEvents.push(e),
        onToolCallComplete: (e) => completeEvents.push(e),
      },
    });

    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].tool).toBe('echo_tool');
    expect(startEvents[0].params).toEqual({ msg: 'hello' });
    expect(startEvents[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0].tool).toBe('echo_tool');
    expect(completeEvents[0].result).toEqual({ msg: 'hello' });
    expect(completeEvents[0].error).toBeUndefined();
    expect(completeEvents[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('includes error in onToolCallComplete when tool fails', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'broken_tool',
      description: 'Always fails',
      parameters: {},
      execute: async () => ({ success: false, error: 'something went wrong' }),
    });

    const mockProvider = new MockProvider([
      {
        content: '',
        tool_calls: [{ id: 'tc-1', name: 'broken_tool', arguments: {} }],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        content: '"recovered"',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
    ]);

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);

    const completeEvents: import('@studio/contracts').ToolCallCompleteEvent[] = [];

    await runAgent({
      agent: { name: 'test-agent', provider: 'mock', model: 'test-model' },
      task: { description: 'Test error callback' },
      context: {},
      toolRegistry,
      providerRegistry,
      callbacks: {
        onToolCallComplete: (e) => completeEvents.push(e),
      },
    });

    expect(completeEvents[0].error).toBe('something went wrong');
    expect(completeEvents[0].result).toBeUndefined();
  });

  it('works fine when no callbacks are provided', async () => {
    const mockProvider = new MockProvider([
      {
        content: '"ok"',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    ]);
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(mockProvider);

    // Should not throw
    await expect(
      runAgent({
        agent: { name: 'test-agent', provider: 'mock', model: 'test-model' },
        task: { description: 'No callbacks' },
        context: {},
        toolRegistry: new ToolRegistry(),
        providerRegistry,
        // callbacks omitted
      })
    ).resolves.toBeDefined();
  });
});
```

**Step 2: Run the tests — confirm they fail**

```bash
pnpm --filter @studio/runner test
```

Expected: `calls onToolCallStart and onToolCallComplete` → FAIL with type error (no `callbacks` field yet).

**Step 3: Add `callbacks` to `RunAgentConfig` in `runner/src/runner.ts`**

Add the import at the top:

```typescript
import type { RunnerCallbacks } from '@studio/contracts';
```

Add `callbacks` to the interface:

```typescript
export interface RunAgentConfig {
  agent: AgentConfig;
  task: TaskInput;
  context: AgentContext;
  executionContext?: ExecutionContext;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  outputContract?: OutputContract;
  maxToolCalls?: number;
  anonymizationMiddleware?: AnonymizationMiddleware;
  callbacks?: RunnerCallbacks;   // ← add this
}
```

**Step 4: Emit callbacks in the standard multi-turn loop**

Find the `for (const tc of response.tool_calls)` loop (around line 145 in runner.ts). Wrap each `toolExecutor.execute()` call:

```typescript
for (const tc of response.tool_calls) {
  const tcStart = Date.now();
  config.callbacks?.onToolCallStart?.({
    tool: tc.name,
    params: tc.arguments,
    timestamp: new Date().toISOString(),
  });

  const executed = await toolExecutor.execute({
    id: tc.id,
    name: tc.name,
    arguments: tc.arguments,
  });
  executedToolCalls.push(executed);
  allToolCalls.push(executed);

  config.callbacks?.onToolCallComplete?.({
    tool: tc.name,
    result: executed.result,
    error: executed.error,
    duration_ms: Date.now() - tcStart,
    timestamp: new Date().toISOString(),
  });
}
```

**Step 5: Run the tests — confirm they pass**

```bash
pnpm --filter @studio/runner test
```

Expected: all tests PASS.

**Step 6: Commit**

```bash
git add runner/src/runner.ts runner/tests/runner.test.ts
git commit -m "feat(runner): emit onToolCallStart/Complete callbacks in multi-turn loop"
```

---

### Task 4: Runner — callbacks in the agent-loop path

**Files:**
- Modify: `runner/src/runner.ts`
- Modify: `runner/tests/runner.test.ts`

**Step 1: Write the failing test**

Add to the `describe('runAgent — callbacks')` block:

```typescript
it('calls callbacks in agent-loop provider path', async () => {
  // AgentLoopProvider mock — owns the full loop and calls executeTool
  const agentLoopProvider: import('../src/providers/provider.js').AgentLoopProvider = {
    name: 'mock-loop',
    call: async () => { throw new Error('not used'); },
    runAgentLoop: async (_req, executeTool) => {
      // Simulate calling one tool
      const outcome = await executeTool('loop_tool', { x: 1 }, 'call-loop-1');
      return {
        content: '"loop done"',
        tool_calls: [{ id: 'call-loop-1', name: 'loop_tool', arguments: { x: 1 }, ...outcome }],
        finish_reason: 'stop',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    },
  };

  const toolRegistry = new ToolRegistry();
  toolRegistry.register({
    name: 'loop_tool',
    description: 'Loop path tool',
    parameters: {},
    execute: async (args) => ({ success: true, output: args }),
  });

  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(agentLoopProvider);

  const startEvents: import('@studio/contracts').ToolCallStartEvent[] = [];
  const completeEvents: import('@studio/contracts').ToolCallCompleteEvent[] = [];

  await runAgent({
    agent: { name: 'test-agent', provider: 'mock-loop', model: 'test-model' },
    task: { description: 'Test loop callbacks' },
    context: {},
    toolRegistry,
    providerRegistry,
    callbacks: {
      onToolCallStart: (e) => startEvents.push(e),
      onToolCallComplete: (e) => completeEvents.push(e),
    },
  });

  expect(startEvents).toHaveLength(1);
  expect(startEvents[0].tool).toBe('loop_tool');
  expect(completeEvents).toHaveLength(1);
  expect(completeEvents[0].tool).toBe('loop_tool');
  expect(completeEvents[0].result).toEqual({ x: 1 });
});
```

**Step 2: Run to confirm it fails**

```bash
pnpm --filter @studio/runner test
```

Expected: new test FAIL.

**Step 3: Emit callbacks in the agent-loop path**

In `runner/src/runner.ts`, find the `isAgentLoopProvider` branch. The `executeTool` callback passed to `provider.runAgentLoop()` is where tool calls happen. Wrap it:

```typescript
const loopResult = await provider.runAgentLoop(
  {
    model: agent.model,
    messages,
    tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
    temperature: agent.temperature,
    max_tokens: agent.max_tokens,
    stage_name: task.contract_name,
  },
  async (name, args, callId) => {
    const tcStart = Date.now();
    config.callbacks?.onToolCallStart?.({
      tool: name,
      params: args,
      timestamp: new Date().toISOString(),
    });

    const executed = await toolExecutor.execute({ id: callId, name, arguments: args });
    allToolCalls.push(executed);

    config.callbacks?.onToolCallComplete?.({
      tool: name,
      result: executed.result,
      error: executed.error,
      duration_ms: Date.now() - tcStart,
      timestamp: new Date().toISOString(),
    });

    // Injection point 2: Anonymize tool results before returning to LLM
    let result = executed.result;
    if (mw && result !== undefined) {
      const resultStr = mw.anonymize(JSON.stringify(result));
      try { result = JSON.parse(resultStr); } catch { result = resultStr; }
    }
    return { result, error: executed.error };
  }
);
```

**Step 4: Run to confirm all pass**

```bash
pnpm --filter @studio/runner test
```

Expected: all PASS.

**Step 5: Commit**

```bash
git add runner/src/runner.ts runner/tests/runner.test.ts
git commit -m "feat(runner): emit callbacks in agent-loop provider path"
```

---

### Task 5: Engine — pass callbacks to `runAgent()`

**Files:**
- Modify: `engine/src/engine.ts`

No new unit test — the change is mechanical and verified by TypeScript types plus the existing engine e2e test.

**Step 1: Find the `runAgent()` call in `engine/src/engine.ts`**

Search for `await runAgent({` — it's in the `executeStage` method.

**Step 2: Add `callbacks` to the call**

```typescript
const result = await runAgent({
  agent: agentConfig,
  task: taskInput,
  context: agentContext,
  executionContext: runnerExecContext,
  toolRegistry: this.config.toolRegistry,
  providerRegistry: this.config.providerRegistry,
  outputContract: contract ?? undefined,
  maxToolCalls: stageDef.ralph?.max_tool_calls,
  anonymizationMiddleware: runMiddleware ?? stageMiddleware ?? undefined,
  callbacks: this.events ? {
    onToolCallStart: this.events.onToolCallStart,
    onToolCallComplete: this.events.onToolCallComplete,
  } : undefined,
});
```

**Step 3: Build everything**

```bash
pnpm build
```

Expected: clean build, no errors.

**Step 4: Commit**

```bash
git add engine/src/engine.ts
git commit -m "feat(engine): pass onToolCallStart/Complete callbacks to runAgent"
```

---

### Task 6: CLI formatters — `getToolIcon`, `summarizeToolParams`, `summarizeToolResult` (TDD)

**Files:**
- Modify: `cli/tests/output/formatters.test.ts`
- Modify: `cli/src/output/formatters.ts`

**Step 1: Write failing tests**

Add a new `describe` block at the end of `cli/tests/output/formatters.test.ts`:

```typescript
describe('getToolIcon', () => {
  it('returns 📖 for read_file tools', () => {
    expect(getToolIcon('repo_manager-read_file')).toBe('📖');
  });

  it('returns ✏️ for write_file tools', () => {
    expect(getToolIcon('repo_manager-write_file')).toBe('✏️');
  });

  it('returns 📁 for list_files tools', () => {
    expect(getToolIcon('repo_manager-list_files')).toBe('📁');
  });

  it('returns 🔍 for search tools', () => {
    expect(getToolIcon('search-search_codebase')).toBe('🔍');
  });

  it('returns ⚙️ for shell tools', () => {
    expect(getToolIcon('shell-run_command')).toBe('⚙️');
  });

  it('returns 🔀 for git tools', () => {
    expect(getToolIcon('git-commit')).toBe('🔀');
  });

  it('returns 🔧 for unknown tools', () => {
    expect(getToolIcon('custom-unknown_tool')).toBe('🔧');
  });
});

describe('summarizeToolParams', () => {
  it('shows path for read_file', () => {
    expect(summarizeToolParams('repo_manager-read_file', { path: 'src/app.ts' }))
      .toBe('(src/app.ts)');
  });

  it('shows path for write_file', () => {
    expect(summarizeToolParams('repo_manager-write_file', { path: 'src/new.ts', content: '...' }))
      .toBe('(src/new.ts)');
  });

  it('shows path for list_files when present', () => {
    expect(summarizeToolParams('repo_manager-list_files', { path: 'src/' }))
      .toBe('(src/)');
  });

  it('returns empty string for list_files without path', () => {
    expect(summarizeToolParams('repo_manager-list_files', {})).toBe('');
  });

  it('shows query for search tools', () => {
    expect(summarizeToolParams('search-search_codebase', { query: 'useState' }))
      .toBe('("useState")');
  });

  it('shows command for shell tools', () => {
    expect(summarizeToolParams('shell-run_command', { command: 'npm test' }))
      .toBe('("npm test")');
  });

  it('returns empty string for unknown tools', () => {
    expect(summarizeToolParams('custom-do_thing', { foo: 'bar' })).toBe('');
  });
});

describe('summarizeToolResult', () => {
  it('returns error message when error is set', () => {
    expect(summarizeToolResult(undefined, 'file not found')).toBe('file not found');
  });

  it('returns line count for multi-line strings', () => {
    expect(summarizeToolResult('line1\nline2\nline3')).toBe('3 lines');
  });

  it('returns truncated string for single-line string under 60 chars', () => {
    expect(summarizeToolResult('short result')).toBe('short result');
  });

  it('truncates long single-line strings to 60 chars', () => {
    expect(summarizeToolResult('x'.repeat(80))).toHaveLength(60);
  });

  it('returns item count for arrays', () => {
    expect(summarizeToolResult(['a', 'b', 'c'])).toBe('3 items');
  });

  it('returns Done for other types', () => {
    expect(summarizeToolResult({ key: 'value' })).toBe('Done');
  });

  it('returns Done for null', () => {
    expect(summarizeToolResult(null)).toBe('Done');
  });
});
```

Update the import at the top of the test file to include the new functions:

```typescript
import {
  humanReadableStageName,
  summarizeToolCalls,
  summarizeOutput,
  getToolIcon,
  summarizeToolParams,
  summarizeToolResult,
} from '../../src/output/formatters.js';
```

**Step 2: Run to confirm they fail**

```bash
pnpm --filter @studio/cli test
```

Expected: new tests FAIL with "getToolIcon is not a function" (or similar import error).

**Step 3: Implement in `cli/src/output/formatters.ts`**

Append these three functions at the end of the file:

```typescript
// ── Live mode helpers ─────────────────────────────────────────────────────────

export function getToolIcon(tool: string): string {
  if (tool.startsWith('repo_manager-read')) return '📖';
  if (tool.startsWith('repo_manager-write')) return '✏️';
  if (tool.startsWith('repo_manager-list')) return '📁';
  if (tool.startsWith('search')) return '🔍';
  if (tool.startsWith('shell')) return '⚙️';
  if (tool.startsWith('git')) return '🔀';
  return '🔧';
}

export function summarizeToolParams(tool: string, params: Record<string, unknown>): string {
  if (tool.includes('read_file') || tool.includes('write_file')) return `(${params.path})`;
  if (tool.includes('list_files')) return params.path ? `(${params.path})` : '';
  if (tool.includes('search')) return `("${params.query}")`;
  if (tool.includes('run_command')) return `("${params.command}")`;
  return '';
}

export function summarizeToolResult(result: unknown, error?: string): string {
  if (error) return error;
  if (typeof result === 'string') {
    const lines = result.split('\n').length;
    return lines > 1 ? `${lines} lines` : result.slice(0, 60);
  }
  if (Array.isArray(result)) return `${result.length} items`;
  return 'Done';
}
```

**Step 4: Run to confirm all pass**

```bash
pnpm --filter @studio/cli test
```

Expected: all PASS.

**Step 5: Commit**

```bash
git add cli/src/output/formatters.ts cli/tests/output/formatters.test.ts
git commit -m "feat(cli): add getToolIcon, summarizeToolParams, summarizeToolResult for live mode"
```

---

### Task 7: `ProgressDisplay` — `displayMode` + live rendering

**Files:**
- Modify: `cli/src/output/progress.ts`

Testing visual/spinner output is impractical. The key behavioral invariant to test is that `getEvents()` exposes `onToolCallStart` and `onToolCallComplete` — verify via the existing test suite that all existing events still work in quiet/verbose modes (no regressions).

**Step 1: Update the constructor**

Replace:
```typescript
constructor(
  private jsonMode: boolean,
  private verbose: boolean
) {}
```

With:
```typescript
private displayMode: 'quiet' | 'verbose' | 'live';
private toolSpinner: import('ora').Ora | null = null;

constructor(
  private jsonMode: boolean,
  displayMode: 'quiet' | 'verbose' | 'live'
) {
  this.displayMode = displayMode;
}
```

Add a convenience getter to clean up the conditions below:
```typescript
private get verbose(): boolean { return this.displayMode === 'verbose'; }
private get live(): boolean { return this.displayMode === 'live'; }
```

**Step 2: Update `onStageStart`**

```typescript
onStageStart: (event) => {
  if (this.jsonMode) return;
  const index = `[${event.stage_index + 1}/${event.total_stages}]`;
  const label = humanReadableStageName(event.stage_name);
  this.spinnerText = `${index} ${label}`;
  if (this.live) {
    // In live mode: plain line — tool call spinners take over
    console.log(chalk.cyan(`${this.spinnerText}...`));
  } else {
    this.spinner = ora({ text: this.spinnerText, color: 'cyan' }).start();
  }
},
```

**Step 3: Update `onStageComplete`**

The existing spinner success/fail logic is unchanged for quiet/verbose. Add a branch for live mode at the start:

```typescript
onStageComplete: (event) => {
  if (this.jsonMode) return;

  const duration = formatDuration(event.duration_ms);
  const label = humanReadableStageName(event.stage_name);
  const attemptsStr = `${event.attempts} attempt${event.attempts !== 1 ? 's' : ''}`;

  if (this.live) {
    // No spinner to stop — just print completion line
    if (event.status === 'success') {
      console.log(chalk.green(`  ✓`) + chalk.gray(` (${attemptsStr}, ${duration})`));
    } else if (event.status === 'rejected') {
      console.log(chalk.red(`  ✗ rejected`) + chalk.gray(` (${duration})`));
      if (event.rejection_reason) console.log(chalk.red(`    ${event.rejection_reason}`));
    } else {
      console.log(chalk.red(`  ✗ failed`) + chalk.gray(` (${attemptsStr}, ${duration})`));
    }
  } else if (event.status === 'success') {
    // ... existing spinner succeed logic (unchanged) ...
  } else if (event.status === 'rejected') {
    // ... existing spinner fail + rejection detail logic (unchanged) ...
  } else {
    // ... existing spinner fail logic (unchanged) ...
  }

  this.spinner = null;

  // Tool call summary: shown in quiet + verbose, skip in live (shown individually)
  if (!this.live && event.tool_calls && event.tool_calls.length > 0) {
    const summary = summarizeToolCalls(event.tool_calls);
    if (summary) console.log(chalk.gray(`  ${summary}`));
  }

  // Output summary: shown in all modes
  if (event.status !== 'rejected' && event.output) {
    const summary = summarizeOutput(event.output);
    if (summary) console.log(chalk.gray(`  ${summary}`));
  }

  // Verbose extras (not in live mode)
  if (this.verbose && event.output) { /* ... unchanged ... */ }
  if (this.verbose && event.token_usage) { /* ... unchanged ... */ }
},
```

**Step 4: Add `onToolCallStart` and `onToolCallComplete` to `getEvents()`**

Import the new formatters at the top of `progress.ts`:
```typescript
import { humanReadableStageName, summarizeToolCalls, summarizeOutput, getToolIcon, summarizeToolParams, summarizeToolResult } from './formatters.js';
```

Add to the returned object from `getEvents()`:

```typescript
onToolCallStart: (event) => {
  if (this.jsonMode || !this.live) return;
  const icon = getToolIcon(event.tool);
  const params = summarizeToolParams(event.tool, event.params);
  this.toolSpinner = ora({
    text: chalk.white(`${icon} ${event.tool}${params}`),
    indent: 2,
    color: 'cyan',
  }).start();
},

onToolCallComplete: (event) => {
  if (this.jsonMode || !this.live) return;
  const summary = summarizeToolResult(event.result, event.error);
  if (event.error) {
    this.toolSpinner?.fail(chalk.red(`${event.tool} — ${event.error}`));
  } else {
    this.toolSpinner?.succeed(chalk.gray(summary));
  }
  this.toolSpinner = null;
},
```

**Step 5: Run tests to confirm no regressions**

```bash
pnpm --filter @studio/cli test
```

Expected: all existing tests PASS.

**Step 6: Build everything**

```bash
pnpm build
```

Expected: clean build.

**Step 7: Commit**

```bash
git add cli/src/output/progress.ts
git commit -m "feat(cli): ProgressDisplay gains displayMode with live spinner rendering"
```

---

### Task 8: CLI run command — `--live` flag

**Files:**
- Modify: `cli/src/commands/run.ts`

**Step 1: Add `live` to `RunOptions`**

```typescript
interface RunOptions {
  input?: string;
  inputFile?: string;
  repo?: string;
  repoUrl?: string;
  config?: string;
  json?: boolean;
  verbose?: boolean;
  live?: boolean;     // ← add
  provider?: string;
  anonymize?: boolean;
}
```

**Step 2: Add display mode logic and update `ProgressDisplay` instantiation**

Replace:
```typescript
const progress = new ProgressDisplay(!!options.json, !!options.verbose);
```

With:
```typescript
const verbose = !!options.verbose;
const live = !!options.live;

if (verbose && live) {
  console.warn(chalk.yellow('⚠ Warning: --live includes all --verbose output. Ignoring --verbose.\n'));
}

const displayMode = live ? 'live' : verbose ? 'verbose' : 'quiet';
const progress = new ProgressDisplay(!!options.json, displayMode);
```

**Step 3: Register the `--live` flag with Commander**

Find where the command is defined (in `cli/src/index.ts` or wherever `program.command('run')` is). Add:

```typescript
.option('--live', 'Stream each tool call in real time as the agent executes it')
```

alongside the existing `--verbose` option.

**Step 4: Build and verify types**

```bash
pnpm build
```

Expected: clean build.

**Step 5: Commit**

```bash
git add cli/src/commands/run.ts cli/src/index.ts   # adjust if flag is elsewhere
git commit -m "feat(cli): add --live flag to studio run for real-time tool call streaming"
```

---

### Task 9: Full build and smoke test

**Step 1: Build everything from root**

```bash
pnpm build
```

Expected: all 5 packages build successfully.

**Step 2: Run all tests**

```bash
pnpm test
```

Expected: all tests pass.

**Step 3: Smoke test with mock provider**

A mock.yaml must exist for the project. Run with the mock provider and `--live` to verify the display:

```bash
studio run software/feature-builder --input "Add dark mode toggle" --provider mock --live
```

Expected terminal output:
```
Running pipeline: software/feature-builder
Run ID: <id>

[1/4] Analyzing brief...
  ⠋ 📖 repo_manager-read_file(src/pages/about.tsx)
  ✓ 247 lines
  ✓ (1 attempt, 2s)
  ...

✓ Pipeline completed in 8s
```

**Step 4: Verify `--verbose --live` warning**

```bash
studio run software/feature-builder --input "test" --provider mock --verbose --live
```

Expected: `⚠ Warning: --live includes all --verbose output. Ignoring --verbose.` printed once before the run.

**Step 5: Verify quiet mode is unchanged**

```bash
studio run software/feature-builder --input "test" --provider mock
```

Expected: same output as before this feature — no tool call lines, just stage-level spinner and summary.
