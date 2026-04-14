# Pipeline Observability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-stage output summaries, tool call details, token usage, and duration to pipeline output.

**Architecture:** Tokens accumulate in the runner's multi-turn loop, the engine generates human-readable summaries and emits dedicated event types, and the CLI renders them with normal/verbose/JSON modes.

**Tech Stack:** TypeScript, Vitest, chalk

---

### Task 1: Runner — token accumulation

**Files:**
- Modify: `runner/src/runner.ts:23-29` (AgentRunResult interface)
- Modify: `runner/src/runner.ts:42-148` (runAgent function)
- Test: `runner/tests/runner.test.ts`

**Step 1: Write the failing test for token_usage on single-turn**

Add to `runner/tests/runner.test.ts`:

```typescript
it('should track token usage from single response', async () => {
  const mockProvider = new MockProvider([
    {
      content: '{"result": "ok"}',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    },
  ]);

  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(mockProvider);
  const toolRegistry = new ToolRegistry();

  const result = await runAgent({
    agent: { name: 'test-agent', provider: 'mock', model: 'test-model' },
    task: { description: 'Test tokens' },
    context: {},
    toolRegistry,
    providerRegistry,
  });

  expect(result.token_usage).toEqual({
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd runner && npx vitest run tests/runner.test.ts`
Expected: FAIL — `token_usage` is undefined

**Step 3: Write the failing test for token accumulation across multi-turn**

Add to `runner/tests/runner.test.ts`:

```typescript
it('should accumulate token usage across multi-turn tool calls', async () => {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register({
    name: 'tool_a',
    description: 'Tool A',
    parameters: {},
    execute: async () => ({ success: true, output: 'result' }),
  });

  const mockProvider = new MockProvider([
    {
      content: '',
      tool_calls: [{ id: 'call-1', name: 'tool_a', arguments: {} }],
      finish_reason: 'tool_calls',
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    },
    {
      content: '"done"',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 },
    },
  ]);

  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(mockProvider);

  const result = await runAgent({
    agent: { name: 'test-agent', provider: 'mock', model: 'test-model' },
    task: { description: 'Test accumulation' },
    context: {},
    toolRegistry,
    providerRegistry,
  });

  expect(result.token_usage).toEqual({
    prompt_tokens: 250,
    completion_tokens: 50,
    total_tokens: 300,
  });
});
```

**Step 4: Run test to verify it fails**

Run: `cd runner && npx vitest run tests/runner.test.ts`
Expected: FAIL

**Step 5: Implement token accumulation in runAgent**

In `runner/src/runner.ts`:

1. Add `token_usage` to `AgentRunResult` interface:

```typescript
export interface AgentRunResult {
  output: unknown;
  tool_calls: ToolCall[];
  tool_calls_count: number;
  raw_response: LLMResponse;
  duration_ms: number;
  token_usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
```

2. Add token accumulator before the while loop (after line 73):

```typescript
const tokenAccumulator = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
```

3. After each `provider.call()` response (after line 86), accumulate:

```typescript
if (response.usage) {
  tokenAccumulator.prompt_tokens += response.usage.prompt_tokens;
  tokenAccumulator.completion_tokens += response.usage.completion_tokens;
  tokenAccumulator.total_tokens += response.usage.total_tokens;
}
```

4. In the return object (line 142-148), add:

```typescript
token_usage: tokenAccumulator.total_tokens > 0 ? tokenAccumulator : undefined,
```

**Step 6: Run tests to verify they pass**

Run: `cd runner && npx vitest run tests/runner.test.ts`
Expected: ALL PASS

**Step 7: Build runner**

Run: `cd runner && npm run build`
Expected: No errors

**Step 8: Commit**

```bash
git add runner/src/runner.ts runner/tests/runner.test.ts
git commit -m "feat(runner): accumulate token usage across multi-turn tool calls"
```

---

### Task 2: Engine events — dedicated event types

**Files:**
- Modify: `engine/src/events.ts`
- Modify: `engine/src/index.ts` (export new types)

**Step 1: Replace EngineEvents with dedicated event types**

Replace the content of `engine/src/events.ts` with:

```typescript
// Event types for pipeline observability
// Dedicated event types — separate from contract types (PipelineRun, StageRun)

export interface ToolCallSummary {
  name: string;
  arguments_summary: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface PipelineStartEvent {
  pipeline_name: string;
  run_id: string;
}

export interface PipelineCompleteEvent {
  pipeline_name: string;
  run_id: string;
  status: string;
  duration_ms: number;
  total_tokens: number;
  total_tool_calls: number;
}

export interface StageStartEvent {
  stage_name: string;
  stage_index: number;
  total_stages: number;
}

export interface StageCompleteEvent {
  stage_name: string;
  stage_index: number;
  total_stages: number;
  status: string;
  attempts: number;
  duration_ms: number;
  output_summary?: string;
  output?: unknown;
  tool_calls?: ToolCallSummary[];
  token_usage?: TokenUsage;
}

export interface StageRetryEvent {
  stage: string;
  attempt: number;
  failures: string[];
  agent_output_raw?: string;
  tool_calls_count?: number;
}

export interface EngineEvents {
  onPipelineStart?: (event: PipelineStartEvent) => void;
  onPipelineComplete?: (event: PipelineCompleteEvent) => void;
  onStageStart?: (event: StageStartEvent) => void;
  onStageComplete?: (event: StageCompleteEvent) => void;
  onTaskRetry?: (event: StageRetryEvent) => void;
}

// Keep the generic event bus for other use cases
export type PipelineEvent =
  | { type: 'pipeline_start'; pipelineId: string }
  | { type: 'pipeline_complete'; pipelineId: string }
  | { type: 'stage_start'; stageId: string; stageName: string }
  | { type: 'stage_complete'; stageId: string; stageName: string }
  | { type: 'task_retry'; stageName: string; attempt: number; failures: string[]; rawOutput?: string };

export class PipelineEventEmitter {
  private listeners: Array<(event: PipelineEvent) => void> = [];

  on(listener: (event: PipelineEvent) => void): void {
    this.listeners.push(listener);
  }

  emit(event: PipelineEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
```

**Step 2: Update engine/src/index.ts exports**

Add the new event types to the exports:

```typescript
export type {
  EngineEvents,
  PipelineEvent,
  PipelineStartEvent,
  PipelineCompleteEvent,
  StageStartEvent,
  StageCompleteEvent,
  StageRetryEvent,
  ToolCallSummary,
  TokenUsage,
} from './events.js';
```

**Step 3: Build engine to check types compile**

Run: `cd engine && npm run build`
Expected: Will fail because engine.ts still emits old-shaped events. That's OK — we fix it in Task 3.

**Step 4: Commit**

```bash
git add engine/src/events.ts engine/src/index.ts
git commit -m "feat(engine): add dedicated event types for observability"
```

---

### Task 3: Engine — summary generation + enriched event emission

**Files:**
- Modify: `engine/src/engine.ts`
- Test: `engine/tests/engine.test.ts`

**Step 1: Write failing test for enriched stage events**

Add to `engine/tests/engine.test.ts`:

```typescript
it('emits enriched stage complete events with summary and tokens', async () => {
  const stageEvents: any[] = [];
  const pipelineEvents: any[] = [];
  const engineEvents: EngineEvents = {
    onPipelineStart: () => {},
    onPipelineComplete: (e) => pipelineEvents.push(e),
    onStageStart: () => {},
    onStageComplete: (e) => stageEvents.push(e),
  };

  const engine = new PipelineEngine(
    {
      pipelinesDir: PIPELINES_DIR,
      agentsDir: AGENTS_DIR,
      contractsDir: CONTRACTS_DIR,
      providerRegistry: createMockProviderRegistry() as any,
      toolRegistry: createMockToolRegistry() as any,
    },
    engineEvents
  );

  await engine.run({ pipeline: 'simple', input: 'test enriched events' });

  expect(stageEvents).toHaveLength(1);
  const e = stageEvents[0];
  expect(e.stage_name).toBe('analysis');
  expect(e.stage_index).toBe(0);
  expect(e.total_stages).toBe(1);
  expect(e.status).toBe('success');
  expect(e.attempts).toBe(1);
  expect(e.duration_ms).toBeGreaterThanOrEqual(0);
  expect(e.output_summary).toBeDefined();
  expect(typeof e.output_summary).toBe('string');
});

it('emits pipeline complete with totals', async () => {
  const pipelineEvents: any[] = [];
  const engineEvents: EngineEvents = {
    onPipelineComplete: (e) => pipelineEvents.push(e),
  };

  const engine = new PipelineEngine(
    {
      pipelinesDir: PIPELINES_DIR,
      agentsDir: AGENTS_DIR,
      contractsDir: CONTRACTS_DIR,
      providerRegistry: createMockProviderRegistry() as any,
      toolRegistry: createMockToolRegistry() as any,
    },
    engineEvents
  );

  await engine.run({ pipeline: 'simple', input: 'test totals' });

  expect(pipelineEvents).toHaveLength(1);
  const e = pipelineEvents[0];
  expect(e.status).toBe('success');
  expect(typeof e.total_tokens).toBe('number');
  expect(typeof e.total_tool_calls).toBe('number');
  expect(typeof e.duration_ms).toBe('number');
});
```

**Step 2: Run tests to verify they fail**

Run: `cd engine && npx vitest run tests/engine.test.ts`
Expected: FAIL — events have wrong shape

**Step 3: Update the existing lifecycle event test**

The test at line 177 (`'emits lifecycle events'`) will break because the event signatures changed. Update it:

```typescript
it('emits lifecycle events', async () => {
  const events: string[] = [];
  const engineEvents: EngineEvents = {
    onPipelineStart: () => events.push('pipeline_start'),
    onPipelineComplete: () => events.push('pipeline_complete'),
    onStageStart: () => events.push('stage_start'),
    onStageComplete: () => events.push('stage_complete'),
  };

  // ... rest stays the same ...
});
```

This test already works because the callbacks just push strings regardless of argument shape. But verify it still passes.

**Step 4: Implement summary functions and update engine**

In `engine/src/engine.ts`, add summary functions before the class:

```typescript
import type {
  ToolCallSummary,
  StageCompleteEvent,
  StageStartEvent,
  StageRetryEvent,
  PipelineStartEvent,
  PipelineCompleteEvent,
} from './events.js';
import type { ToolCall, StageKind } from '@studio-foundation/contracts';

function summarizeOutput(output: unknown, stageKind: StageKind): string {
  if (!output || typeof output !== 'object') return 'no structured output';
  const o = output as Record<string, unknown>;

  switch (stageKind) {
    case 'analysis': {
      const reqs = Array.isArray(o.requirements) ? o.requirements.length : 0;
      const criteria = Array.isArray(o.acceptance_criteria) ? o.acceptance_criteria.length : 0;
      return `${reqs} requirements, ${criteria} acceptance criteria`;
    }
    case 'planning': {
      const steps = Array.isArray(o.steps) ? o.steps.length : 0;
      const files = Array.isArray(o.files_to_modify) ? o.files_to_modify.length : 0;
      return `${steps} steps, ${files} files to modify`;
    }
    case 'code_generation': {
      const files = Array.isArray(o.files_changed) ? o.files_changed.length : 0;
      return `${files} files changed`;
    }
    case 'qa': {
      const status = String(o.status || 'unknown');
      const issues = Array.isArray(o.issues) ? o.issues.length : 0;
      return `status: ${status}, ${issues} issues`;
    }
    default: {
      const keys = Object.keys(o);
      return `${keys.length} fields: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}`;
    }
  }
}

function summarizeToolCalls(toolCalls: ToolCall[]): ToolCallSummary[] {
  return toolCalls.map(tc => ({
    name: tc.name,
    arguments_summary: extractToolArgSummary(tc),
  }));
}

function extractToolArgSummary(tc: ToolCall): string {
  const args = tc.arguments as Record<string, unknown>;
  if (tc.name.includes('write_file') || tc.name.includes('read_file')) {
    return String(args.path || '');
  }
  if (tc.name.includes('list_files')) {
    return String(args.path || args.directory || '.');
  }
  if (tc.name.includes('run_command')) {
    const cmd = String(args.command || '');
    return cmd.length > 40 ? cmd.slice(0, 40) + '...' : cmd;
  }
  if (tc.name.includes('search')) {
    return String(args.pattern || '');
  }
  return '';
}
```

Then update the `run()` method to track totals:

After `let previousStageName` (line 93), add:

```typescript
let totalTokens = 0;
let totalToolCalls = 0;
const pipelineStartTime = Date.now();
```

Update `executeStage` to accept `stageIndex` and `totalStages` parameters, and return enriched data.

The `executeStage` method signature becomes:

```typescript
private async executeStage(
  stageDef: StageDefinition,
  pipelineContext: PipelineContext,
  previousStageName: string | undefined,
  userInput: string | Record<string, unknown>,
  stageIndex: number,
  totalStages: number,
): Promise<StageRun>
```

Emit `onStageStart` with the new event shape:

```typescript
this.events?.onStageStart?.({
  stage_name: stageDef.name,
  stage_index: stageIndex,
  total_stages: totalStages,
});
```

After the ralph loop completes, extract observability data from `ralphResult` and emit the enriched `onStageComplete`:

```typescript
// Extract result data for observability
const lastResult = ralphResult.status === 'success' ? ralphResult.result : undefined;
const stageDurationMs = stageRun.completed_at && stageRun.started_at
  ? new Date(stageRun.completed_at).getTime() - new Date(stageRun.started_at).getTime()
  : 0;

this.events?.onStageComplete?.({
  stage_name: stageDef.name,
  stage_index: stageIndex,
  total_stages: totalStages,
  status: stageStatus,
  attempts: ralphResult.attempts,
  duration_ms: stageDurationMs,
  output_summary: lastResult ? summarizeOutput(lastResult.output, stageDef.kind) : undefined,
  output: lastResult?.output,
  tool_calls: lastResult ? summarizeToolCalls(lastResult.tool_calls) : undefined,
  token_usage: lastResult?.token_usage,
});
```

Update the `onTaskRetry` callback to include tool_calls_count:

```typescript
onRetry: async (event) => {
  const rawOutput = typeof event.result.output === 'string'
    ? event.result.output
    : JSON.stringify(event.result.output, null, 2);

  this.events?.onTaskRetry?.({
    stage: stageDef.name,
    attempt: event.attempt,
    failures: event.allFailures,
    agent_output_raw: rawOutput,
    tool_calls_count: event.result.tool_calls_count,
  });
  // ... emitter.emit stays the same ...
},
```

Update `onPipelineStart` emissions to use the new event shape:

```typescript
this.events?.onPipelineStart?.({
  pipeline_name: pipeline.name,
  run_id: pipelineRun.id,
});
```

In the stage loop, accumulate totals after each successful stage:

```typescript
if (stageRun.status === 'success') {
  const agentRuns = stageRun.tasks[0]?.agent_runs;
  const lastAgentRun = agentRuns?.[agentRuns.length - 1];
  // ... existing context propagation ...
}
// Accumulate totals from the ralph result (regardless of status)
// We need to track these even for failed stages for the pipeline summary
```

Actually, totals need to come from the `ralphResult` not from `stageRun`. Since `executeStage` returns `StageRun`, we need a way to get the totals back. Add a mutable accumulator object:

Add a private field to the class:

```typescript
private pipelineTotals = { tokens: 0, toolCalls: 0 };
```

Reset it at the start of `run()`, accumulate in `executeStage`, and use in the final `onPipelineComplete`:

```typescript
this.events?.onPipelineComplete?.({
  pipeline_name: pipeline.name,
  run_id: pipelineRun.id,
  status: pipelineRun.status,
  duration_ms: Date.now() - pipelineStartTime,
  total_tokens: this.pipelineTotals.tokens,
  total_tool_calls: this.pipelineTotals.toolCalls,
});
```

In `executeStage`, after the ralph loop:

```typescript
if (lastResult) {
  this.pipelineTotals.toolCalls += lastResult.tool_calls_count || 0;
  if (lastResult.token_usage) {
    this.pipelineTotals.tokens += lastResult.token_usage.total_tokens;
  }
}
```

**Step 5: Update the for loop call site**

```typescript
for (let i = 0; i < pipeline.stages.length; i++) {
  const stageDef = pipeline.stages[i];
  const stageRun = await this.executeStage(
    stageDef,
    pipelineContext,
    previousStageName,
    input.input,
    i,
    pipeline.stages.length,
  );
  // ... rest stays the same
}
```

**Step 6: Run tests to verify they pass**

Run: `cd engine && npx vitest run tests/engine.test.ts`
Expected: ALL PASS

**Step 7: Build engine**

Run: `cd engine && npm run build`
Expected: No errors

**Step 8: Commit**

```bash
git add engine/src/engine.ts engine/src/events.ts engine/src/index.ts engine/tests/engine.test.ts
git commit -m "feat(engine): emit enriched observability events with summaries and totals"
```

---

### Task 4: CLI — export formatDuration

**Files:**
- Modify: `cli/src/output/formatter.ts:67-73`

**Step 1: Export the existing formatDuration function**

In `cli/src/output/formatter.ts`, change `function formatDuration` to `export function formatDuration`. Also add sub-second formatting:

```typescript
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${remainingSeconds.toString().padStart(2, '0')}s`;
}
```

**Step 2: Build CLI to verify**

Run: `cd cli && npm run build`
Expected: No errors

**Step 3: Commit**

```bash
git add cli/src/output/formatter.ts
git commit -m "refactor(cli): export formatDuration for use in progress display"
```

---

### Task 5: CLI — enriched progress display

**Files:**
- Modify: `cli/src/output/progress.ts`
- Test: `cli/tests/formatter.test.ts` (add formatDuration sub-second test)

**Step 1: Write failing test for formatDuration sub-second**

Add to `cli/tests/formatter.test.ts`:

```typescript
import { formatDuration } from '../src/output/formatter.js';

describe('formatDuration', () => {
  it('should format sub-second durations', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  it('should format seconds', () => {
    expect(formatDuration(12000)).toBe('12s');
  });

  it('should format minutes', () => {
    expect(formatDuration(83000)).toBe('1m23s');
  });
});
```

**Step 2: Run test to verify it passes (since we already implemented)**

Run: `cd cli && npx vitest run tests/formatter.test.ts`
Expected: PASS

**Step 3: Update ProgressDisplay to use enriched events**

Replace `cli/src/output/progress.ts` with:

```typescript
import chalk from 'chalk';
import type { EngineEvents } from '@studio-foundation/engine';
import { formatDuration } from './formatter.js';

export class ProgressDisplay {
  constructor(
    private jsonMode: boolean,
    private verbose: boolean
  ) {}

  getEvents(): EngineEvents {
    return {
      onPipelineStart: (event) => {
        if (this.jsonMode) return;
        console.log(chalk.blue(`\nRunning pipeline: ${event.pipeline_name}`));
        console.log(chalk.gray(`Run ID: ${event.run_id}\n`));
      },

      onStageStart: (event) => {
        if (this.jsonMode) return;
        const index = `[${event.stage_index + 1}/${event.total_stages}]`;
        const name = event.stage_name;
        const dots = '.'.repeat(Math.max(2, 30 - name.length));
        process.stdout.write(chalk.gray(`  ${index} ${name} ${dots} `));
      },

      onStageComplete: (event) => {
        if (this.jsonMode) return;

        // Status line: ✓/✗ + attempts + duration
        const duration = formatDuration(event.duration_ms);
        if (event.status === 'success') {
          console.log(
            chalk.green('✓') +
            chalk.gray(` (${event.attempts} attempt${event.attempts !== 1 ? 's' : ''}, ${duration})`)
          );
        } else {
          console.log(
            chalk.red('✗ FAILED') +
            chalk.gray(` (${event.attempts} attempts, ${duration})`)
          );
        }

        // Output summary
        if (event.output_summary) {
          console.log(chalk.gray(`        → ${event.output_summary}`));
        }

        // Tool calls summary
        if (event.tool_calls && event.tool_calls.length > 0) {
          const tcSummary = event.tool_calls
            .map(tc => {
              const shortName = tc.name.split('.').pop();
              return tc.arguments_summary
                ? `${shortName}(${tc.arguments_summary})`
                : shortName;
            })
            .join(', ');
          console.log(chalk.gray(`        → ${event.tool_calls.length} tool calls: ${tcSummary}`));
        }

        // Verbose: full JSON output
        if (this.verbose && event.output) {
          console.log(chalk.gray('        Output:'));
          const json = JSON.stringify(event.output, null, 2);
          const lines = json.split('\n');
          for (const line of lines.slice(0, 20)) {
            console.log(chalk.gray(`          ${line}`));
          }
          if (lines.length > 20) {
            console.log(chalk.gray(`          ... (${lines.length - 20} more lines)`));
          }
        }

        // Verbose: token breakdown
        if (this.verbose && event.token_usage) {
          const u = event.token_usage;
          console.log(chalk.gray(`        Tokens: ${u.prompt_tokens} prompt + ${u.completion_tokens} completion = ${u.total_tokens} total`));
        }
      },

      onTaskRetry: (event) => {
        if (this.jsonMode) return;

        // Always show retries (not just verbose)
        console.log(chalk.yellow(`        ↻ Retry #${event.attempt}:`));
        for (const failure of event.failures) {
          console.log(chalk.yellow(`          - ${failure}`));
        }

        // Verbose: raw agent response
        if (this.verbose && event.agent_output_raw) {
          console.log(chalk.gray(`          Agent response (truncated):`));
          console.log(chalk.gray(`            ${event.agent_output_raw.slice(0, 300)}`));
        }

        // Verbose: tool calls count
        if (this.verbose && event.tool_calls_count !== undefined) {
          console.log(chalk.gray(`          Tool calls made: ${event.tool_calls_count}`));
        }
      },

      onPipelineComplete: (event) => {
        if (this.jsonMode) return;

        console.log('');
        if (event.status === 'success') {
          console.log(chalk.green(`✓ Pipeline completed in ${formatDuration(event.duration_ms)}`));
        } else {
          console.log(chalk.red(`✗ Pipeline failed after ${formatDuration(event.duration_ms)}`));
        }

        // Token and tool call totals
        const parts: string[] = [];
        if (event.total_tokens > 0) {
          parts.push(`${event.total_tokens.toLocaleString()} tokens`);
        }
        if (event.total_tool_calls > 0) {
          parts.push(`${event.total_tool_calls} tool calls`);
        }
        if (parts.length > 0) {
          console.log(chalk.gray(`  ${parts.join(' | ')}`));
        }
      },
    };
  }
}
```

**Step 4: Build CLI**

Run: `cd cli && npm run build`
Expected: No errors

**Step 5: Run CLI tests**

Run: `cd cli && npx vitest run`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add cli/src/output/progress.ts cli/tests/formatter.test.ts
git commit -m "feat(cli): display enriched observability data in pipeline progress"
```

---

### Task 6: Full build + verify

**Step 1: Build entire workspace**

Run: `npm run build:all`
Expected: No errors

**Step 2: Run all tests**

Run: `cd runner && npx vitest run && cd ../engine && npx vitest run && cd ../cli && npx vitest run`
Expected: ALL PASS

**Step 3: Commit if any fixes were needed**

Only if fixes were required during verification.
