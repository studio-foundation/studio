# Live nested-stage progress (STU-620) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under `studio run --live`, render child pipeline stage/tool progress indented by nesting depth, to full depth, suppressing the child token/thinking firehose below the top level.

**Architecture:** Child engines currently carry no event sink, so their stage events die inside the child. We thread a per-spawn tagging adapter through `DirectEngineSpawner`: it wraps the parent's `EngineEvents` and stamps every forwarded call with `{ depth, childId }`. The CLI reads that context and renders child events as static indented lines (no nested ora spinners), dropping token/thinking events at depth ≥ 1.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, chalk/ora (CLI). Engine tests use the `script`/`shell` executor (no LLM).

## Global Constraints

- **Package boundaries:** `contracts` is a leaf — do NOT touch it (`EngineEvents` lives in `engine`, not `contracts`). Engine stays domain-agnostic: `depth`/`childId` are orchestration facts, never domain.
- **Build:** single `pnpm build` at monorepo root; rebuilds packages in dependency order.
- **Tests:** `pnpm --filter <pkg> test` runs `vitest run` (non-watch).
- **Back-compat:** the `EngineEvents` signature change is additive/optional — top-level consumers that ignore the 2nd argument keep working; `ctx` undefined ⇒ depth 0.
- **Comments:** default to none; only a `why` comment where an invariant isn't obvious.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Work happens in worktree `.worktrees/stu-620-live-nested-progress` on branch `feat/stu-620-live-nested-progress`.

---

### Task 1: Event context + tagging adapter

**Files:**
- Modify: `engine/src/events.ts` (add `EventContext`; widen all `EngineEvents` callbacks with `ctx?: EventContext`; add `createTaggingAdapter`)
- Test: `engine/tests/tagging-adapter.test.ts` (create)

**Interfaces:**
- Produces:
  - `interface EventContext { depth: number; childId: string }`
  - `function createTaggingAdapter(parent: EngineEvents, ctx: EventContext): EngineEvents`
  - `EngineEvents` callbacks now `(event: X, ctx?: EventContext) => void`

- [ ] **Step 1: Write the failing test**

Create `engine/tests/tagging-adapter.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createTaggingAdapter, type EngineEvents } from '../src/events.js';

describe('createTaggingAdapter', () => {
  it('forwards each call to the parent handler with the ctx appended', () => {
    const onStageStart = vi.fn();
    const parent: EngineEvents = { onStageStart };
    const adapter = createTaggingAdapter(parent, { depth: 2, childId: 'd2#0' });

    adapter.onStageStart!({ stage_name: 's', stage_index: 0, total_stages: 1, max_attempts: 1 });

    expect(onStageStart).toHaveBeenCalledWith(
      { stage_name: 's', stage_index: 0, total_stages: 1, max_attempts: 1 },
      { depth: 2, childId: 'd2#0' },
    );
  });

  it('exposes only handlers the parent actually defined', () => {
    const parent: EngineEvents = { onStageStart: vi.fn() };
    const adapter = createTaggingAdapter(parent, { depth: 1, childId: 'd1#0' });

    expect(typeof adapter.onStageStart).toBe('function');
    expect(adapter.onStageComplete).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @studio-foundation/engine test tagging-adapter`
Expected: FAIL — `createTaggingAdapter` is not exported.

- [ ] **Step 3: Add `EventContext` and widen the interface**

In `engine/src/events.ts`, add above `export interface EngineEvents`:

```ts
/** Orchestration context stamped onto child-run events by the spawner. */
export interface EventContext {
  depth: number;   // 0 = top-level engine, 1+ = spawned child
  childId: string; // stable per child run, minted by the spawner
}
```

Then append `, ctx?: EventContext` to the parameter list of **every** callback in `EngineEvents`. Example (apply to all 21):

```ts
export interface EngineEvents {
  onPipelineStart?: (event: PipelineStartEvent, ctx?: EventContext) => void;
  onPipelineComplete?: (event: PipelineCompleteEvent, ctx?: EventContext) => void;
  onPipelineCancelled?: (event: PipelineCancelledEvent, ctx?: EventContext) => void;
  onStageStart?: (event: StageStartEvent, ctx?: EventContext) => void;
  onStageComplete?: (event: StageCompleteEvent, ctx?: EventContext) => void;
  onTaskRetry?: (event: StageRetryEvent, ctx?: EventContext) => void;
  onGroupStart?: (event: GroupStartEvent, ctx?: EventContext) => void;
  onGroupIteration?: (event: GroupIterationEvent, ctx?: EventContext) => void;
  onGroupFeedback?: (event: GroupFeedbackEvent, ctx?: EventContext) => void;
  onGroupComplete?: (event: GroupCompleteEvent, ctx?: EventContext) => void;
  onMapStart?: (event: MapStartEvent, ctx?: EventContext) => void;
  onMapItemStart?: (event: MapItemStartEvent, ctx?: EventContext) => void;
  onMapItemComplete?: (event: MapItemCompleteEvent, ctx?: EventContext) => void;
  onMapComplete?: (event: MapCompleteEvent, ctx?: EventContext) => void;
  onStageContext?: (event: StageContextEvent, ctx?: EventContext) => void;
  onToolCallStart?: (event: StagedToolCallStartEvent, ctx?: EventContext) => void;
  onToolCallComplete?: (event: StagedToolCallCompleteEvent, ctx?: EventContext) => void;
  onAgentThinking?: (event: StagedAgentThinkingEvent, ctx?: EventContext) => void;
  onAgentProgress?: (event: StagedAgentProgressEvent, ctx?: EventContext) => void;
  onAgentToken?: (event: StagedAgentTokenEvent, ctx?: EventContext) => void;
}
```

- [ ] **Step 4: Add `createTaggingAdapter`**

Append to `engine/src/events.ts` (after the `EngineEvents` interface):

```ts
/**
 * Wrap a parent event sink so a child run's events reach it stamped with `ctx`.
 * A Proxy forwards any defined handler, injecting ctx as the trailing argument;
 * the child engine keeps emitting one-arg calls unchanged.
 */
export function createTaggingAdapter(parent: EngineEvents, ctx: EventContext): EngineEvents {
  return new Proxy({} as EngineEvents, {
    get(_target, prop: string) {
      const handler = (parent as Record<string, unknown>)[prop];
      if (typeof handler !== 'function') return undefined;
      return (event: unknown) => (handler as (e: unknown, c: EventContext) => void).call(parent, event, ctx);
    },
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @studio-foundation/engine test tagging-adapter`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add engine/src/events.ts engine/tests/tagging-adapter.test.ts
git commit -m "feat(engine): event context + tagging adapter for child runs (STU-620)"
```

---

### Task 2: Spawn child engines with a tagged event sink

**Files:**
- Modify: `engine/src/spawners/direct-engine-spawner.ts`
- Modify: `engine/tests/nested-call.test.ts` (add a depth-tagging test to the existing suite)

**Interfaces:**
- Consumes: `createTaggingAdapter`, `EventContext`, `EngineEvents` (Task 1).
- Produces: `new DirectEngineSpawner(engineConfig, events?: EngineEvents)` — child engines emit their stage/tool events to `events`, each stamped with `{ depth: config.depth, childId }`. `childId` format: `` `d${depth}#${n}` `` (`n` monotonic per spawner instance).

- [ ] **Step 1: Write the failing test**

Append to `engine/tests/nested-call.test.ts` inside the existing `describe`:

```ts
  it('stamps child stage events with their nesting depth (STU-620)', async () => {
    const { PipelineEngine } = await import('../src/engine.js');
    const { DirectEngineSpawner } = await import('../src/spawners/direct-engine-spawner.js');
    const { InMemoryRunStore } = await import('../src/state/run-store.js');
    const root = mkdtempSync(join(tmpdir(), 'studio-depth-events-'));
    try {
      writeConfigs(root);
      const engineConfig = {
        configsDir: root,
        repoPath: root,
        providerRegistry: { get: () => undefined, register: () => undefined } as any,
        db: new InMemoryRunStore(),
      } as unknown as EngineConfig;

      const seen: Array<{ stage: string; depth?: number; childId?: string }> = [];
      const events = {
        onStageStart: (e: any, ctx?: any) =>
          seen.push({ stage: e.stage_name, depth: ctx?.depth, childId: ctx?.childId }),
      };

      const spawner = new DirectEngineSpawner(engineConfig, events);
      const engine = new PipelineEngine({ ...engineConfig, spawner, maxDepth: 3 }, events);
      const result = await engine.run({ pipeline: 'parent', input: { book: 'x' } });
      expect(result.status).toBe('success');

      const leafCall = seen.find(s => s.stage === 'leaf-call');   // mid pipeline stage, depth 1
      const leafStage = seen.find(s => s.stage === 'leaf-stage'); // leaf pipeline stage, depth 2
      expect(leafCall?.depth).toBe(1);
      expect(leafStage?.depth).toBe(2);
      expect(typeof leafCall?.childId).toBe('string');
      expect(leafStage?.childId).not.toBe(leafCall?.childId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @studio-foundation/engine test nested-call`
Expected: FAIL — `leafCall?.depth` is `undefined` (spawner ignores events; child has no sink).

- [ ] **Step 3: Thread events + tagging adapter through the spawner**

Rewrite `engine/src/spawners/direct-engine-spawner.ts`:

```ts
import type { RunSpawner, SpawnConfig, SpawnResult, PipelineRun } from '@studio-foundation/contracts';
import { PipelineEngine, type EngineConfig } from '../engine.js';
import { createTaggingAdapter, type EngineEvents } from '../events.js';

export class DirectEngineSpawner implements RunSpawner {
  private childCounter = 0;

  constructor(private engineConfig: EngineConfig, private events?: EngineEvents) {}

  async spawnAndWait(config: SpawnConfig): Promise<SpawnResult> {
    // Hand the spawner down: without it a child engine cannot run `call`/`map`
    // stages of its own, capping nesting at depth 1 while maxDepth promises 3
    // (STU-615). The orchestrators' depth guard is the recursion limit.
    //
    // Stamp the child's events with its depth + a unique childId so the CLI can
    // render nested progress and keep concurrent map siblings apart (STU-620).
    const childEvents = this.events
      ? createTaggingAdapter(this.events, { depth: config.depth, childId: `d${config.depth}#${this.childCounter++}` })
      : undefined;
    const child = new PipelineEngine({ ...this.engineConfig, spawner: this }, childEvents);
    const result: PipelineRun = await child.run({
      pipeline: config.pipeline,
      input: config.input,
      parentRunId: config.parentRunId,
      depth: config.depth,
    });

    if (result.status === 'failed' || result.status === 'rejected' || result.status === 'cancelled') {
      throw new Error(`Child run ${result.id} ${result.status}`);
    }

    const lastStage = [...result.stages].reverse().find(s => s.status === 'success');
    const output = (lastStage as { output?: unknown } | undefined)?.output ?? null;

    return { run_id: result.id, status: result.status, output };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @studio-foundation/engine test nested-call`
Expected: PASS (existing STU-615 test + the new depth-tagging test).

- [ ] **Step 5: Commit**

```bash
git add engine/src/spawners/direct-engine-spawner.ts engine/tests/nested-call.test.ts
git commit -m "feat(engine): spawn child engines with a depth-tagged event sink (STU-620)"
```

---

### Task 3: Render child events as indented static lines

**Files:**
- Modify: `cli/src/output/progress.ts`
- Test: `cli/tests/progress-nested.test.ts` (create)

**Interfaces:**
- Consumes: `EngineEvents` callbacks now receive `ctx?: EventContext` (Task 1).
- Produces: in `--live`, an event with `ctx.depth >= 1` prints one static indented line (indent `'  '.repeat(depth)`); `onAgentToken`/`onAgentThinking` at depth ≥ 1 print nothing; depth 0 (or `ctx` undefined) is unchanged.

**Design note:** child events must NOT start ora spinners — a spinner owns the last terminal line, and nesting one under the parent stage's "Thinking…" spinner corrupts the display. Child stage/tool events render as plain `console.log` lines (the same tactic `ParallelRenderer`/`MapRenderer` already use). Before printing a child line, stop the parent's active thinking/tool spinner so it doesn't smear.

- [ ] **Step 1: Write the failing test**

Create `cli/tests/progress-nested.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressDisplay } from '../src/output/progress.js';

describe('ProgressDisplay — nested child events (STU-620)', () => {
  let logs: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    spy = vi.spyOn(console, 'log').mockImplementation((s?: unknown) => { logs.push(String(s ?? '')); });
  });
  afterEach(() => { spy.mockRestore(); });

  function live() { return new ProgressDisplay(false, { live: true, verbose: false }); }

  it('indents a child stage-start line by its depth', () => {
    const ev = live().getEvents();
    ev.onStageStart!(
      { stage_name: 'child-stage', stage_index: 0, total_stages: 2, max_attempts: 1 },
      { depth: 1, childId: 'd1#0' },
    );
    const line = logs.find(l => l.includes('child-stage'));
    expect(line).toBeDefined();
    expect(line!.startsWith('  ')).toBe(true); // indented once
  });

  it('drops child token + thinking events at depth >= 1', () => {
    const ev = live().getEvents();
    ev.onAgentToken!({ stage: 'child-stage', token: 'x' } as any, { depth: 1, childId: 'd1#0' });
    ev.onAgentThinking!({ stage: 'child-stage', text: 'y' } as any, { depth: 1, childId: 'd1#0' });
    expect(logs.join('')).not.toContain('x');
    expect(logs.join('')).not.toContain('y');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @studio-foundation/cli test progress-nested`
Expected: FAIL — child stage-start line is not indented (current handler ignores `ctx` and starts an ora spinner instead of logging).

- [ ] **Step 3: Add a child-event helper**

In `cli/src/output/progress.ts`, add these private methods to the `ProgressDisplay` class (near `resetStageTimer`):

```ts
  private indent(depth: number): string {
    return '  '.repeat(depth);
  }

  /** Stop any spinner that owns the current line before printing a static child line. */
  private stopSpinnersForChildLine(): void {
    this.thinkingSpinner?.stop();
    this.thinkingSpinner = null;
    this.toolSpinner?.stop();
    this.toolSpinner = null;
    this.clearTimer();
  }
```

- [ ] **Step 4: Guard the relevant handlers on `ctx.depth`**

In `getEvents()`, add a depth guard as the FIRST line of each handler below. Each handler's signature gains `, ctx` and returns early for child events after printing a static line. Apply exactly these edits:

`onStageStart: (event, ctx) => {` — after the `if (this.jsonMode) return;` line, insert:

```ts
        if (ctx && ctx.depth >= 1) {
          this.stopSpinnersForChildLine();
          const prefix = `[${event.stage_index + 1}/${event.total_stages}]`;
          console.log(this.indent(ctx.depth) + chalk.cyan(`${prefix} ${event.stage_name}...`));
          return;
        }
```

`onStageComplete: (event, ctx) => {` — after `if (this.jsonMode) return;`, insert:

```ts
        if (ctx && ctx.depth >= 1) {
          const mark = event.status === 'success' ? chalk.green('✓')
            : event.status === 'skipped' ? chalk.gray('⊘')
            : event.status === 'rejected' ? chalk.yellow('rejected')
            : chalk.red('✗');
          console.log(this.indent(ctx.depth) + `${mark} ${event.stage_name}`);
          return;
        }
```

`onToolCallStart: (event, ctx) => {` — after `if (this.jsonMode) return;`, insert:

```ts
        if (ctx && ctx.depth >= 1) {
          this.stopSpinnersForChildLine();
          console.log(this.indent(ctx.depth + 1) + chalk.dim(`${getToolIcon(event.tool)} ${event.tool}(${summarizeToolParams(event.tool, event.params)})`));
          return;
        }
```

`onToolCallComplete: (event, ctx) => {` — after `if (this.jsonMode) return;`, insert:

```ts
        if (ctx && ctx.depth >= 1) {
          console.log(this.indent(ctx.depth + 1) + chalk.dim(`  → ${summarizeToolResult(event.tool, event.result)}`));
          return;
        }
```

`onAgentToken: (event, ctx) => {` — insert as the FIRST line:

```ts
        if (ctx && ctx.depth >= 1) return;
```

`onAgentThinking: (event, ctx) => {` — insert as the FIRST line:

```ts
        if (ctx && ctx.depth >= 1) return;
```

`onAgentProgress: (event, ctx) => {` — insert as the FIRST line:

```ts
        if (ctx && ctx.depth >= 1) return;
```

> Note: match the exact property names on each event when wiring the tool lines — `event.tool`, `event.params`, `event.result` come from `StagedToolCallStartEvent`/`StagedToolCallCompleteEvent`. If a name differs in the current file, use the file's name; the guard block is what matters.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @studio-foundation/cli test progress-nested`
Expected: PASS (both tests).

- [ ] **Step 6: Verify existing progress tests still pass**

Run: `pnpm --filter @studio-foundation/cli test`
Expected: PASS — depth-0 behavior unchanged.

- [ ] **Step 7: Commit**

```bash
git add cli/src/output/progress.ts cli/tests/progress-nested.test.ts
git commit -m "feat(cli): render child stage/tool progress indented under --live (STU-620)"
```

---

### Task 4: Wire events into the spawner + update stale doc comment

**Files:**
- Modify: `cli/src/commands/run.ts` (~line 425 — `new DirectEngineSpawner(engineConfig)`)
- Modify: `cli/src/output/map-progress.ts:17-20` (the "child sub-pipeline stages are COLLAPSED" comment)

**Interfaces:**
- Consumes: `new DirectEngineSpawner(engineConfig, events)` (Task 2).

**Note:** this task is the activation switch — child events only reach the CLI once the spawner receives `events`. It must land AFTER Task 3 (CLI rendering) so child events don't hit the old un-guarded handlers.

- [ ] **Step 1: Pass events into the spawner**

In `cli/src/commands/run.ts`, find:

```ts
const spawner = new DirectEngineSpawner(engineConfig);
```

Replace with:

```ts
const spawner = new DirectEngineSpawner(engineConfig, events);
```

(`events` is the same `ProgressDisplay.getEvents()` object already passed to the top `PipelineEngine` a few lines below — confirm it is in scope at this point; if the `events` const is declared after this line, move the spawner construction below it.)

- [ ] **Step 2: Update the stale comment in `map-progress.ts`**

Replace the block at `cli/src/output/map-progress.ts:17-20` that states child stages are collapsed because child runs carry no event sink. New comment:

```ts
// Map items render one line each here. Child sub-pipeline stages now bubble up
// via the spawner's tagging adapter (STU-620) and are printed indented by the
// ProgressDisplay handlers; this renderer still owns the per-item summary line.
```

- [ ] **Step 3: Build the whole monorepo**

Run: `pnpm build`
Expected: builds all packages in order with no type errors (the widened `EngineEvents` signature must type-check across engine + cli).

- [ ] **Step 4: Manual smoke test (nested call, mock provider)**

Run a nested pipeline under `--live` against the mock provider (or the engine test fixtures) and confirm child stages print indented and no depth-≥1 token stream appears:

Run: `pnpm --filter @studio-foundation/engine test && pnpm --filter @studio-foundation/cli test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/run.ts cli/src/output/map-progress.ts
git commit -m "feat(cli): activate nested child progress + refresh map-progress note (STU-620)"
```

---

## Self-Review

**Spec coverage:**
- Layer 1 (`events.ts` — `EventContext` + widened signatures) → Task 1. ✓
- Layer 2 (spawner tagging adapter, per-spawn `childId`, `depth` from `config.depth`) → Task 1 (adapter) + Task 2 (spawner). ✓
- Layer 3 (CLI indent + suppress token/thinking at depth ≥ 1, depth-0 unchanged, group by `childId`) → Task 3. ✓
- Wiring (`run.ts` passes events to spawner) → Task 4. ✓
- map-progress comment update → Task 4. ✓
- Testing (adapter tags; 4-level ordering / depth; concurrent map distinct childId; CLI indent + token drop) → Task 1 + Task 2 + Task 3 tests. ✓

**Correction vs spec:** the spec's "forwarding chain carries each level's context outward" is imprecise. STU-615 shares ONE spawner instance whose `this.events` is the top sink; every adapter wraps that same top sink and stamps the **absolute** `config.depth`. Wrapping is flat, not chained — simpler, and it still tags correct absolute depth. Behavior matches the spec's intent (child events reach the CLI depth-tagged).

**Placeholder scan:** none — every code step shows complete code.

**Type consistency:** `EventContext { depth, childId }`, `createTaggingAdapter(parent, ctx)`, `new DirectEngineSpawner(engineConfig, events)`, `childId` = `` `d${depth}#${n}` `` used consistently across Tasks 1–4.

**Ordering constraint:** Task 4 (activation) MUST land after Task 3 (rendering), else child events hit un-guarded handlers and corrupt the display. Stated in Task 4.
