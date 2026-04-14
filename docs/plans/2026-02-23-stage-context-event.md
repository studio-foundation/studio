# stage_context Event Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Emit a `stage_context` event at every stage start so context propagation is observable and debuggable via the JSONL run log.

**Architecture:** Add `StageContextEvent` to `EngineEvents`, pre-track output sizes in `PipelineContext` to avoid re-serialization at emit time, emit the event in `executeStage()` after context assembly but before the ralph loop, handle it in the CLI's `mergeEvents()` for JSONL logging.

**Tech Stack:** TypeScript, Vitest, `process.env.DEBUG` for flag checking, no new packages.

---

### Task 1: Add `StageContextEvent` type to `events.ts`

**Files:**
- Modify: `engine/src/events.ts`

No tests for this task — it's type-only, TypeScript compilation validates it.

**Step 1: Add the interface and update `EngineEvents`**

In `engine/src/events.ts`, add after the `GroupCompleteEvent` interface (line 91) and before `StagedAgentThinkingEvent`:

```typescript
export interface StageContextEvent {
  stage: string;
  run_id: string;
  context_keys: Record<string, number>;
  context_content?: Record<string, unknown>;
  system_prompt?: string;
}
```

Then add `onStageContext?: (event: StageContextEvent) => void;` to the `EngineEvents` interface (after `onGroupComplete?`).

**Step 2: Build to verify no type errors**

```bash
pnpm build
```
Expected: exits 0.

**Step 3: Commit**

```bash
git add engine/src/events.ts
git commit -m "feat(engine): add StageContextEvent type to EngineEvents"
```

---

### Task 2: Pre-track output sizes in `PipelineContext`

**Files:**
- Modify: `engine/src/pipeline/context-propagation.ts`
- Test: `engine/src/pipeline/context-propagation.test.ts`

The goal: when `addStageOutput()` is called, compute `JSON.stringify(output).length` and store it in a new `stageOutputSizes` map. This avoids re-serializing at emit time.

**Step 1: Write the failing tests**

Add a new `describe` block at the end of `context-propagation.test.ts`:

```typescript
import {
  createInitialContext,
  getContextForStage,
  addStageOutput,
} from './context-propagation.js';

describe('addStageOutput — size tracking', () => {
  it('tracks serialized size when output is added', () => {
    const ctx = createInitialContext('input');
    const output = { summary: 'hello', items: [1, 2, 3] };
    addStageOutput(ctx, 'my-stage', output);

    const expectedSize = JSON.stringify(output).length;
    expect(ctx.stageOutputSizes.get('my-stage')).toBe(expectedSize);
  });

  it('tracks size for each stage independently', () => {
    const ctx = createInitialContext('input');
    const out1 = { a: 'short' };
    const out2 = { b: 'a much longer value here', c: [1, 2, 3, 4, 5] };
    addStageOutput(ctx, 'stage-1', out1);
    addStageOutput(ctx, 'stage-2', out2);

    expect(ctx.stageOutputSizes.get('stage-1')).toBe(JSON.stringify(out1).length);
    expect(ctx.stageOutputSizes.get('stage-2')).toBe(JSON.stringify(out2).length);
  });

  it('createInitialContext initializes stageOutputSizes as empty map', () => {
    const ctx = createInitialContext('input');
    expect(ctx.stageOutputSizes).toBeInstanceOf(Map);
    expect(ctx.stageOutputSizes.size).toBe(0);
  });
});
```

**Step 2: Run to verify they fail**

```bash
cd engine && pnpm test -- context-propagation
```
Expected: FAIL with `ctx.stageOutputSizes is not a Map` or `undefined`.

**Step 3: Implement**

In `context-propagation.ts`:

1. Add `stageOutputSizes: Map<string, number>;` to `PipelineContext` interface (after `startupContext?`).

2. Update `createInitialContext()` to add `stageOutputSizes: new Map()` in the returned object.

3. Update `addStageOutput()`:

```typescript
export function addStageOutput(
  context: PipelineContext,
  stageName: string,
  output: unknown
): PipelineContext {
  context.stageOutputs.set(stageName, output);
  context.stageOutputSizes.set(stageName, JSON.stringify(output).length);
  return context;
}
```

**Step 4: Run tests**

```bash
cd engine && pnpm test -- context-propagation
```
Expected: all passing.

**Step 5: Build**

```bash
pnpm build
```
Expected: exits 0.

**Step 6: Commit**

```bash
git add engine/src/pipeline/context-propagation.ts engine/src/pipeline/context-propagation.test.ts
git commit -m "feat(engine): track output sizes in PipelineContext for zero-cost context_keys"
```

---

### Task 3: `buildContextKeys()` and `buildContextContent()` helpers

**Files:**
- Modify: `engine/src/pipeline/context-propagation.ts`
- Test: `engine/src/pipeline/context-propagation.test.ts`

These are pure functions that derive the event payload from `AgentContext`.

**Step 1: Write the failing tests**

Add a new `describe` block in `context-propagation.test.ts`. First add the new imports at the top:

```typescript
import {
  createInitialContext,
  getContextForStage,
  addStageOutput,
  buildContextKeys,
  buildContextContent,
} from './context-propagation.js';
import type { AgentContext } from '@studio-foundation/runner';
```

Then the test block:

```typescript
describe('buildContextKeys', () => {
  it('returns empty object for empty AgentContext', () => {
    const ctx: AgentContext = {};
    expect(buildContextKeys(ctx, new Map())).toEqual({});
  });

  it('includes input key when additional_context is set', () => {
    const ctx: AgentContext = { additional_context: 'hello world' };
    const keys = buildContextKeys(ctx, new Map());
    expect(keys.input).toBe('hello world'.length);
  });

  it('includes previous_stage_output with total size from size map', () => {
    const ctx: AgentContext = {
      previous_outputs: { 'brief-analysis': { summary: 'ok' } },
    };
    const sizes = new Map([['brief-analysis', 42]]);
    const keys = buildContextKeys(ctx, sizes);
    expect(keys.previous_stage_output).toBe(42);
  });

  it('sums sizes for multiple previous outputs', () => {
    const ctx: AgentContext = {
      previous_outputs: {
        'stage-a': { x: 1 },
        'stage-b': { y: 2 },
      },
    };
    const sizes = new Map([['stage-a', 10], ['stage-b', 20]]);
    const keys = buildContextKeys(ctx, sizes);
    expect(keys.previous_stage_output).toBe(30);
  });

  it('includes group_feedback key', () => {
    const feedback = { iteration: 1, max_iterations: 3, rejection_reason: 'nope' };
    const ctx: AgentContext = { group_feedback: feedback };
    const keys = buildContextKeys(ctx, new Map());
    expect(keys.group_feedback).toBe(JSON.stringify(feedback).length);
  });

  it('expands startup_context keys individually', () => {
    const ctx: AgentContext = {
      startup_context: {
        git_status: 'M src/foo.ts',
        recent_commits: 'abc def',
      },
    };
    const keys = buildContextKeys(ctx, new Map());
    expect(keys.git_status).toBe('M src/foo.ts'.length);
    expect(keys.recent_commits).toBe('abc def'.length);
    expect(keys.input).toBeUndefined();
  });

  it('includes context packs by name with total section chars', () => {
    const ctx: AgentContext = {
      context_packs: [
        {
          name: 'api-docs',
          sections: [
            { title: 'intro', content: 'hello' },
            { title: 'details', content: 'world!' },
          ],
        },
      ],
    };
    const keys = buildContextKeys(ctx, new Map());
    expect(keys['api-docs']).toBe('hello'.length + 'world!'.length);
  });

  it('omits absent keys', () => {
    const ctx: AgentContext = { additional_context: 'x' };
    const keys = buildContextKeys(ctx, new Map());
    expect(Object.keys(keys)).toEqual(['input']);
  });
});

describe('buildContextContent', () => {
  it('returns empty object for empty AgentContext', () => {
    expect(buildContextContent({})).toEqual({});
  });

  it('maps input key to additional_context value', () => {
    const ctx: AgentContext = { additional_context: 'my input' };
    expect(buildContextContent(ctx).input).toBe('my input');
  });

  it('maps previous_stage_output to previous_outputs object', () => {
    const ctx: AgentContext = { previous_outputs: { 'stage-a': { x: 1 } } };
    expect(buildContextContent(ctx).previous_stage_output).toEqual({ 'stage-a': { x: 1 } });
  });

  it('maps group_feedback key', () => {
    const fb = { iteration: 1, max_iterations: 3, rejection_reason: 'fail' };
    const ctx: AgentContext = { group_feedback: fb };
    expect(buildContextContent(ctx).group_feedback).toEqual(fb);
  });

  it('expands startup_context keys individually', () => {
    const ctx: AgentContext = { startup_context: { git_status: 'clean' } };
    expect(buildContextContent(ctx).git_status).toBe('clean');
  });

  it('maps each context pack by name to its pack object', () => {
    const pack = { name: 'api-docs', sections: [{ title: 'h', content: 'c' }] };
    const ctx: AgentContext = { context_packs: [pack] };
    expect(buildContextContent(ctx)['api-docs']).toEqual(pack);
  });
});
```

**Step 2: Run to verify they fail**

```bash
cd engine && pnpm test -- context-propagation
```
Expected: FAIL with `buildContextKeys is not a function`.

**Step 3: Implement**

Add these two exported functions at the end of `context-propagation.ts`:

```typescript
export function buildContextKeys(
  agentContext: AgentContext,
  previousOutputSizes: Map<string, number>,
): Record<string, number> {
  const keys: Record<string, number> = {};

  if (agentContext.additional_context !== undefined) {
    keys['input'] = agentContext.additional_context.length;
  }

  if (agentContext.previous_outputs && Object.keys(agentContext.previous_outputs).length > 0) {
    let total = 0;
    for (const stageName of Object.keys(agentContext.previous_outputs)) {
      total += previousOutputSizes.get(stageName) ?? 0;
    }
    keys['previous_stage_output'] = total;
  }

  if (agentContext.group_feedback !== undefined) {
    keys['group_feedback'] = JSON.stringify(agentContext.group_feedback).length;
  }

  if (agentContext.startup_context) {
    for (const [key, value] of Object.entries(agentContext.startup_context)) {
      keys[key] = value.length;
    }
  }

  if (agentContext.context_packs?.length) {
    for (const pack of agentContext.context_packs) {
      keys[pack.name] = pack.sections.reduce((sum, s) => sum + s.content.length, 0);
    }
  }

  return keys;
}

export function buildContextContent(
  agentContext: AgentContext,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};

  if (agentContext.additional_context !== undefined) {
    content['input'] = agentContext.additional_context;
  }

  if (agentContext.previous_outputs && Object.keys(agentContext.previous_outputs).length > 0) {
    content['previous_stage_output'] = agentContext.previous_outputs;
  }

  if (agentContext.group_feedback !== undefined) {
    content['group_feedback'] = agentContext.group_feedback;
  }

  if (agentContext.startup_context) {
    for (const [key, value] of Object.entries(agentContext.startup_context)) {
      content[key] = value;
    }
  }

  if (agentContext.context_packs?.length) {
    for (const pack of agentContext.context_packs) {
      content[pack.name] = pack;
    }
  }

  return content;
}
```

**Step 4: Run tests**

```bash
cd engine && pnpm test -- context-propagation
```
Expected: all passing.

**Step 5: Build**

```bash
pnpm build
```
Expected: exits 0.

**Step 6: Commit**

```bash
git add engine/src/pipeline/context-propagation.ts engine/src/pipeline/context-propagation.test.ts
git commit -m "feat(engine): add buildContextKeys and buildContextContent helpers"
```

---

### Task 4: Emit `onStageContext` in `executeStage()`

**Files:**
- Modify: `engine/src/engine.ts`
- Create: `engine/src/engine.context-event.test.ts`

**Step 1: Write the failing integration test**

Create `engine/src/engine.context-event.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PipelineEngine } from './engine.js';
import { createDefaultRegistry, ToolRegistry, MockProvider } from '@studio-foundation/runner';
import type { StageContextEvent } from './events.js';

async function makeTestDirs(): Promise<{ configsDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'studio-ctx-test-'));
  const configsDir = join(base, '.studio');
  await mkdir(join(configsDir, 'pipelines'), { recursive: true });
  await mkdir(join(configsDir, 'agents'), { recursive: true });
  await mkdir(join(configsDir, 'contracts'), { recursive: true });

  await writeFile(
    join(configsDir, 'pipelines', 'test-pipe.pipeline.yaml'),
    `
name: test-pipe
description: test
version: 1
stages:
  - name: my-stage
    kind: analysis
    agent: analyst
    context:
      include: [input]
`
  );

  await writeFile(
    join(configsDir, 'agents', 'analyst.agent.yaml'),
    `
name: analyst
provider: mock
model: mock
system_prompt: "You are an analyst."
`
  );

  return { configsDir };
}

describe('PipelineEngine — onStageContext event', () => {
  it('emits onStageContext once per stage', async () => {
    const { configsDir } = await makeTestDirs();

    const mockStages = new Map([
      ['my-stage', { output: { summary: 'done' }, tool_calls: [] }],
    ]);
    const mockProvider = new MockProvider(mockStages);
    const providerRegistry = createDefaultRegistry({});
    providerRegistry.register(mockProvider);
    const toolRegistry = new ToolRegistry();

    const received: StageContextEvent[] = [];

    const engine = new PipelineEngine(
      { configsDir, providerRegistry, toolRegistry },
      { onStageContext: (e) => received.push(e) }
    );

    await engine.run({ pipeline: 'test-pipe', input: 'test input' });

    expect(received).toHaveLength(1);
    expect(received[0].stage).toBe('my-stage');
    expect(received[0].run_id).toMatch(/^[0-9a-f-]{36}$/); // uuid
    expect(received[0].context_keys.input).toBe('test input'.length);
  });

  it('includes no context_content by default (DEBUG unset)', async () => {
    const { configsDir } = await makeTestDirs();
    delete process.env.DEBUG;

    const mockProvider = new MockProvider(
      new Map([['my-stage', { output: { summary: 'done' }, tool_calls: [] }]])
    );
    const providerRegistry = createDefaultRegistry({});
    providerRegistry.register(mockProvider);

    const received: StageContextEvent[] = [];
    const engine = new PipelineEngine(
      { configsDir, providerRegistry, toolRegistry: new ToolRegistry() },
      { onStageContext: (e) => received.push(e) }
    );

    await engine.run({ pipeline: 'test-pipe', input: 'hello' });

    expect(received[0].context_content).toBeUndefined();
    expect(received[0].system_prompt).toBeUndefined();
  });

  it('includes context_content when DEBUG=studio:context', async () => {
    const { configsDir } = await makeTestDirs();
    process.env.DEBUG = 'studio:context';

    const mockProvider = new MockProvider(
      new Map([['my-stage', { output: { summary: 'done' }, tool_calls: [] }]])
    );
    const providerRegistry = createDefaultRegistry({});
    providerRegistry.register(mockProvider);

    const received: StageContextEvent[] = [];
    const engine = new PipelineEngine(
      { configsDir, providerRegistry, toolRegistry: new ToolRegistry() },
      { onStageContext: (e) => received.push(e) }
    );

    await engine.run({ pipeline: 'test-pipe', input: 'hello' });

    expect(received[0].context_content).toBeDefined();
    expect(received[0].context_content?.input).toBe('hello');
    expect(received[0].system_prompt).toBeUndefined();

    delete process.env.DEBUG;
  });

  it('includes system_prompt when DEBUG=studio:context:verbose', async () => {
    const { configsDir } = await makeTestDirs();
    process.env.DEBUG = 'studio:context:verbose';

    const mockProvider = new MockProvider(
      new Map([['my-stage', { output: { summary: 'done' }, tool_calls: [] }]])
    );
    const providerRegistry = createDefaultRegistry({});
    providerRegistry.register(mockProvider);

    const received: StageContextEvent[] = [];
    const engine = new PipelineEngine(
      { configsDir, providerRegistry, toolRegistry: new ToolRegistry() },
      { onStageContext: (e) => received.push(e) }
    );

    await engine.run({ pipeline: 'test-pipe', input: 'hello' });

    expect(received[0].context_content).toBeDefined(); // verbose implies context
    expect(received[0].system_prompt).toBe('You are an analyst.');

    delete process.env.DEBUG;
  });

  it('does not call handler at all when onStageContext is not registered', async () => {
    const { configsDir } = await makeTestDirs();

    const mockProvider = new MockProvider(
      new Map([['my-stage', { output: { summary: 'done' }, tool_calls: [] }]])
    );
    const providerRegistry = createDefaultRegistry({});
    providerRegistry.register(mockProvider);

    // No onStageContext handler
    const engine = new PipelineEngine(
      { configsDir, providerRegistry, toolRegistry: new ToolRegistry() },
      { onStageComplete: vi.fn() } // some other handler but not onStageContext
    );

    // Should not throw
    await engine.run({ pipeline: 'test-pipe', input: 'hello' });
  });
});
```

**Step 2: Run to verify it fails**

```bash
cd engine && pnpm test -- engine.context-event
```
Expected: FAIL — `received` is empty, `onStageContext` is never called.

**Step 3: Implement the emit in `engine.ts`**

First, add the imports at the top of `engine.ts` (in the existing import from `context-propagation.js`):

```typescript
import {
  createInitialContext,
  addStageOutput,
  addStageToolResults,
  getContextForStage,
  setGroupFeedback,
  clearGroupFeedback,
  buildContextKeys,      // ADD
  buildContextContent,   // ADD
  type PipelineContext,
} from './pipeline/context-propagation.js';
```

Also import `StageContextEvent` in the import from `events.js`:

```typescript
import type { EngineEvents, ToolCallSummary, StageContextEvent } from './events.js';
```

Then in `executeStage()`, after the context pack loading (after line ~447, the `if (stageDef.context?.packs?.length)` block) and before the `// Create a single task run` comment, add:

```typescript
// Emit context observability event (zero work if no handler registered)
if (this.events?.onStageContext) {
  const debugFlag = process.env.DEBUG ?? '';
  const includeContent = debugFlag.includes('studio:context');
  const includePrompt  = debugFlag.includes('studio:context:verbose');

  const contextEvent: StageContextEvent = {
    stage: stageDef.name,
    run_id: runId ?? '',
    context_keys: buildContextKeys(agentContext, pipelineContext.stageOutputSizes),
    ...(includeContent ? { context_content: buildContextContent(agentContext) } : {}),
    ...(includePrompt  ? { system_prompt: agentConfig.system_prompt } : {}),
  };

  this.events.onStageContext(contextEvent);
}
```

**Step 4: Run tests**

```bash
cd engine && pnpm test -- engine.context-event
```
Expected: all 5 tests passing.

**Step 5: Build**

```bash
pnpm build
```
Expected: exits 0.

**Step 6: Commit**

```bash
git add engine/src/engine.ts engine/src/engine.context-event.test.ts
git commit -m "feat(engine): emit onStageContext event after context assembly (STU-127)"
```

---

### Task 5: Log `stage_context` to JSONL in CLI

**Files:**
- Modify: `cli/src/commands/run.ts`

No new test file (no CLI test infrastructure exists). The integration test in Task 4 validates the event; the JSONL handler is a straightforward mapping.

**Step 1: Add the handler to `mergeEvents()`**

In `cli/src/commands/run.ts`, in the `mergeEvents()` function, add the `onStageContext` handler after `onStageStart`:

```typescript
onStageContext: (e) => {
  logger.log({
    event: 'stage_context',
    stage: e.stage,
    run_id: e.run_id,
    context_keys: e.context_keys,
    ...(e.context_content !== undefined ? { context_content: e.context_content } : {}),
    ...(e.system_prompt !== undefined ? { system_prompt: e.system_prompt } : {}),
  });
},
```

Note: `onStageContext` is NOT forwarded to `progressEvents` — it's logging-only, not shown on the terminal.

**Step 2: Build**

```bash
pnpm build
```
Expected: exits 0.

**Step 3: Smoke test**

If you have a `.studio/` directory available (or use an existing mock setup):

```bash
studio run <any-pipeline> --provider mock
```

Then inspect the JSONL log in `.studio/runs/`:
```bash
grep '"event":"stage_context"' .studio/runs/*.jsonl
```
Expected: one line per stage with `context_keys`.

**Step 4: Commit**

```bash
git add cli/src/commands/run.ts
git commit -m "feat(cli): log stage_context event to JSONL run log (STU-127)"
```

---

### Task 6: Final build + full test suite

**Step 1: Run all tests**

```bash
pnpm test
```
Expected: all passing, no regressions.

**Step 2: Full build**

```bash
pnpm build
```
Expected: exits 0.

**Step 3: Update Linear issue**

Mark STU-127 acceptance criteria as done.
