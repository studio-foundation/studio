# STU-105 — Tool plugin `studio-run` Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a `studio-run` builtin tool that lets a pipeline agent spawn child Studio runs (via `POST /api/runs` or direct engine call), wait for completion via SSE, and return the result.

**Architecture:** `RunSpawner` interface in contracts; `DirectEngineSpawner` in engine (for CLI); `HttpApiSpawner` in api (for API mode). The `createStudioRunTool` factory in runner closes over a `RunSpawner` + run context (runId, depth). Engine clones its ToolRegistry per-run and injects the studio-run tool when a spawner is configured.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, Node.js fetch (native, 18+)

**Design doc:** `docs/plans/2026-02-25-stu-105-studio-run-tool-design.md`

---

### Task 1: contracts — Add `RunSpawner` + `parent_run_id`

**Files:**
- Create: `contracts/src/spawner.ts`
- Modify: `contracts/src/run.ts`
- Modify: `contracts/src/index.ts`

**Step 1: Create `contracts/src/spawner.ts`**

```typescript
// The abstraction that studio-run tool uses to launch child runs.
// Implementations: DirectEngineSpawner (engine) and HttpApiSpawner (api).

export interface SpawnConfig {
  pipeline: string;
  input: Record<string, unknown>;
  parentRunId: string;
  depth: number;
}

export interface SpawnResult {
  run_id: string;
  status: string;
  output: unknown;
}

export interface RunSpawner {
  spawnAndWait(config: SpawnConfig): Promise<SpawnResult>;
}
```

**Step 2: Add `parent_run_id` to `PipelineRun` in `contracts/src/run.ts`**

Find the `PipelineRun` interface and add one field:

```typescript
export interface PipelineRun {
  id: string;
  pipeline_name: string;
  status: StageStatus;
  started_at: string;
  completed_at?: string;
  stages: StageRun[];
  parent_run_id?: string;   // ← add this
}
```

**Step 3: Export from `contracts/src/index.ts`**

Add at the end:
```typescript
export * from './spawner.js';
```

**Step 4: Build contracts to verify**

```bash
pnpm --filter @studio-foundation/contracts build
```
Expected: success, no TypeScript errors.

**Step 5: Commit**

```bash
git add contracts/src/spawner.ts contracts/src/run.ts contracts/src/index.ts
git commit -m "feat(contracts): RunSpawner interface + parent_run_id on PipelineRun"
```

---

### Task 2: engine — Extend `RunInput` and `EngineConfig`

**Files:**
- Modify: `engine/src/engine.ts`

**Step 1: Extend `RunInput` (around line 120)**

Find `export interface RunInput` and add two fields:

```typescript
export interface RunInput {
  id?: string;
  pipeline: string;
  input: string | Record<string, unknown>;
  meta?: Record<string, unknown>;
  anonymize?: boolean;
  signal?: AbortSignal;
  depth?: number;           // ← add: nesting depth (0 = top-level)
  parentRunId?: string;     // ← add: parent run ID if spawned
}
```

**Step 2: Extend `EngineConfig`**

Find `export interface EngineConfig` and add two fields:

```typescript
export interface EngineConfig {
  configsDir: string;
  repoPath?: string;
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  db?: RunStore;
  providerOverride?: string;
  pluginSkills?: Record<string, string[]>;
  spawner?: RunSpawner;    // ← add: if set, studio-run tool is available
  maxDepth?: number;       // ← add: max nesting depth, default 3
}
```

Add the import at the top of `engine/src/engine.ts`:
```typescript
import type { RunSpawner } from '@studio-foundation/contracts';
```

**Step 3: Build engine to verify**

```bash
pnpm --filter @studio-foundation/engine build
```
Expected: success.

**Step 4: Commit**

```bash
git add engine/src/engine.ts
git commit -m "feat(engine): extend RunInput and EngineConfig for spawner support"
```

---

### Task 3: engine — DB migration for `parent_run_id`

**Files:**
- Modify: `engine/src/state/run-store.ts`
- Test: `engine/tests/run-store.test.ts`

**Step 1: Write failing test**

Open `engine/tests/run-store.test.ts` and add a new `describe` block (or find an existing one for SQLiteRunStore). Add:

```typescript
it('persists and retrieves parent_run_id', () => {
  const run: PipelineRun = {
    id: 'child-123',
    pipeline_name: 'child-pipe',
    status: 'success',
    started_at: new Date().toISOString(),
    stages: [],
    parent_run_id: 'parent-456',
  };
  store.savePipelineRun(run);
  const retrieved = store.getPipelineRun('child-123');
  expect(retrieved?.parent_run_id).toBe('parent-456');
});
```

**Step 2: Run to verify it fails**

```bash
pnpm --filter @studio-foundation/engine test -- --reporter=verbose run-store
```
Expected: FAIL or PASS (the field may already round-trip since it's stored as JSON). If it already passes, the test is still valuable — move on.

**Step 3: Add DB migration in `run-store.ts`**

In `SQLiteRunStore` constructor, after the existing `log_path` migration, add:

```typescript
// Migration: add parent_run_id column to existing databases
try {
  this.db.exec('ALTER TABLE pipeline_runs ADD COLUMN parent_run_id TEXT');
  this.db.exec('CREATE INDEX IF NOT EXISTS idx_pipeline_runs_parent ON pipeline_runs(parent_run_id)');
} catch {
  // Column already exists — ignore
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm --filter @studio-foundation/engine test -- --reporter=verbose run-store
```
Expected: PASS.

**Step 5: Commit**

```bash
git add engine/src/state/run-store.ts engine/tests/run-store.test.ts
git commit -m "feat(engine): add parent_run_id column to pipeline_runs with index"
```

---

### Task 4: runner — `ToolRegistry.clone()`

**Files:**
- Modify: `runner/src/tools/tool-registry.ts`
- Test: `runner/tests/tool-registry.test.ts`

**Step 1: Write failing test**

Open `runner/tests/tool-registry.test.ts` and add:

```typescript
describe('clone', () => {
  it('creates an independent copy with all tools', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('my_plugin', [
      { name: 'my_plugin-cmd', description: 'test', parameters: {}, execute: async () => ({ content: 'ok' }) },
    ], 'my snippet');

    const clone = registry.clone();
    expect(clone.get('my_plugin-cmd')).toBeDefined();
    expect(clone.getActiveSnippets()).toContain('my snippet');
  });

  it('mutations to clone do not affect original', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('original', [
      { name: 'original-cmd', description: 'test', parameters: {}, execute: async () => ({ content: 'ok' }) },
    ]);
    const clone = registry.clone();
    clone.registerPlugin('extra', [
      { name: 'extra-cmd', description: 'test', parameters: {}, execute: async () => ({ content: 'ok' }) },
    ]);
    expect(registry.get('extra-cmd')).toBeUndefined();
  });
});
```

**Step 2: Run to verify it fails**

```bash
pnpm --filter @studio-foundation/runner test -- --reporter=verbose tool-registry
```
Expected: FAIL with "clone is not a function".

**Step 3: Implement `clone()` in `tool-registry.ts`**

Add after the `filter()` method:

```typescript
/**
 * Create a full copy of this registry (all tools + plugin metadata).
 */
clone(): ToolRegistry {
  return this.filter(Array.from(this.tools.keys()));
}
```

**Step 4: Run to verify it passes**

```bash
pnpm --filter @studio-foundation/runner test -- --reporter=verbose tool-registry
```
Expected: PASS.

**Step 5: Commit**

```bash
git add runner/src/tools/tool-registry.ts runner/tests/tool-registry.test.ts
git commit -m "feat(runner): add ToolRegistry.clone() for per-run registry isolation"
```

---

### Task 5: runner — `createStudioRunTool` builtin

**Files:**
- Create: `runner/src/tools/builtin/studio-run.ts`
- Modify: `runner/src/index.ts`
- Test: `runner/tests/studio-run.test.ts`

**Step 1: Write failing tests**

Create `runner/tests/studio-run.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createStudioRunTool } from '../src/tools/builtin/studio-run.js';
import type { RunSpawner } from '@studio-foundation/contracts';

function makeSpawner(overrides?: Partial<RunSpawner>): RunSpawner {
  return {
    spawnAndWait: vi.fn().mockResolvedValue({
      run_id: 'child-abc',
      status: 'success',
      output: { result: 'done' },
    }),
    ...overrides,
  };
}

describe('createStudioRunTool', () => {
  it('returns a tool named studio_run-run_pipeline', () => {
    const tools = createStudioRunTool({
      spawner: makeSpawner(),
      currentRunId: 'parent-1',
      currentDepth: 0,
      maxDepth: 3,
    });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('studio_run-run_pipeline');
  });

  it('throws depth limit error before calling spawner', async () => {
    const spawner = makeSpawner();
    const tools = createStudioRunTool({
      spawner,
      currentRunId: 'parent-1',
      currentDepth: 3,  // already at max
      maxDepth: 3,
    });
    const tool = tools[0];
    await expect(
      tool.execute({ pipeline: 'my-pipe', input: { x: 1 }, wait: true })
    ).rejects.toThrow('studio-run depth limit reached (max: 3)');
    expect(spawner.spawnAndWait).not.toHaveBeenCalled();
  });

  it('calls spawner with correct config and returns result', async () => {
    const spawner = makeSpawner();
    const tools = createStudioRunTool({
      spawner,
      currentRunId: 'parent-1',
      currentDepth: 0,
      maxDepth: 3,
    });
    const result = await tools[0].execute({
      pipeline: 'recipe-developer',
      input: { dish: 'pasta' },
      wait: true,
    });
    expect(spawner.spawnAndWait).toHaveBeenCalledWith({
      pipeline: 'recipe-developer',
      input: { dish: 'pasta' },
      parentRunId: 'parent-1',
      depth: 1,
    });
    expect(result).toEqual({ run_id: 'child-abc', status: 'success', output: { result: 'done' } });
  });

  it('propagates error when spawner throws', async () => {
    const spawner = makeSpawner({
      spawnAndWait: vi.fn().mockRejectedValue(new Error('Child run child-abc failed: contract violation')),
    });
    const tools = createStudioRunTool({
      spawner,
      currentRunId: 'parent-1',
      currentDepth: 0,
      maxDepth: 3,
    });
    await expect(
      tools[0].execute({ pipeline: 'bad-pipe', input: {}, wait: true })
    ).rejects.toThrow('Child run child-abc failed');
  });

  it('throws when wait is false (not supported in v1)', async () => {
    const tools = createStudioRunTool({
      spawner: makeSpawner(),
      currentRunId: 'parent-1',
      currentDepth: 0,
      maxDepth: 3,
    });
    await expect(
      tools[0].execute({ pipeline: 'x', input: {}, wait: false })
    ).rejects.toThrow('wait: false is not supported');
  });
});
```

**Step 2: Run to verify it fails**

```bash
pnpm --filter @studio-foundation/runner test -- --reporter=verbose studio-run
```
Expected: FAIL with "Cannot find module".

**Step 3: Create `runner/src/tools/builtin/studio-run.ts`**

```typescript
import type { RunSpawner } from '@studio-foundation/contracts';
import type { Tool } from '../tool-registry.js';

interface StudioRunContext {
  spawner: RunSpawner;
  currentRunId: string;
  currentDepth: number;
  maxDepth: number;
}

export const STUDIO_RUN_PROMPT_SNIPPET = `
## studio_run tool

Use \`studio_run-run_pipeline\` to launch a Studio pipeline run and wait for its result.
The run executes asynchronously but this tool blocks until completion.
Use it to orchestrate sub-pipelines (e.g. generate N items by launching N runs).
`.trim();

export function createStudioRunTool(ctx: StudioRunContext): Tool[] {
  return [
    {
      name: 'studio_run-run_pipeline',
      description: 'Launch a Studio pipeline run and wait for completion. Returns the output of the last stage.',
      parameters: {
        type: 'object',
        properties: {
          pipeline: {
            type: 'string',
            description: 'Name of the pipeline to run (e.g. "recipe-developer")',
          },
          input: {
            type: 'object',
            description: 'Input data for the pipeline',
          },
          wait: {
            type: 'boolean',
            description: 'Whether to wait for completion before returning (default: true)',
            default: true,
          },
        },
        required: ['pipeline', 'input'],
      },
      async execute(args) {
        const pipeline = args['pipeline'] as string;
        const input = args['input'] as Record<string, unknown>;
        const wait = args['wait'] !== false;

        if (!wait) {
          throw new Error('wait: false is not supported in v1. Use wait: true (default).');
        }

        if (ctx.currentDepth + 1 > ctx.maxDepth) {
          throw new Error(
            `studio-run depth limit reached (max: ${ctx.maxDepth}). ` +
            `Current depth: ${ctx.currentDepth}. Recursive pipeline spawning is not allowed at this level.`
          );
        }

        const result = await ctx.spawner.spawnAndWait({
          pipeline,
          input,
          parentRunId: ctx.currentRunId,
          depth: ctx.currentDepth + 1,
        });

        return result;
      },
    },
  ];
}
```

**Step 4: Run to verify tests pass**

```bash
pnpm --filter @studio-foundation/runner test -- --reporter=verbose studio-run
```
Expected: 5 passing.

**Step 5: Export from `runner/src/index.ts`**

Add to the exports:
```typescript
export { createStudioRunTool, STUDIO_RUN_PROMPT_SNIPPET } from './tools/builtin/studio-run.js';
```

**Step 6: Build runner**

```bash
pnpm --filter @studio-foundation/runner build
```
Expected: success.

**Step 7: Commit**

```bash
git add runner/src/tools/builtin/studio-run.ts runner/src/index.ts runner/tests/studio-run.test.ts
git commit -m "feat(runner): createStudioRunTool builtin with depth limit + throw on failure"
```

---

### Task 6: engine — `DirectEngineSpawner`

**Files:**
- Create: `engine/src/spawners/direct-engine-spawner.ts`
- Test: `engine/tests/direct-engine-spawner.test.ts`

**Step 1: Write failing tests**

Create `engine/tests/direct-engine-spawner.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { DirectEngineSpawner } from '../src/spawners/direct-engine-spawner.js';
import type { EngineConfig } from '../src/engine.js';
import type { PipelineRun } from '@studio-foundation/contracts';

function makeSuccessRun(overrides?: Partial<PipelineRun>): PipelineRun {
  return {
    id: 'child-run-1',
    pipeline_name: 'test-pipe',
    status: 'success',
    started_at: new Date().toISOString(),
    stages: [
      {
        id: 's1',
        stage_name: 'final',
        status: 'success',
        started_at: new Date().toISOString(),
        tasks: [],
        output: { answer: 42 },
      },
    ],
    ...overrides,
  };
}

function makeEngineConfig(runResult: PipelineRun): EngineConfig {
  return {
    configsDir: '/fake',
    providerRegistry: {} as any,
    toolRegistry: {} as any,
    // PipelineEngine constructor receives this config
  } as EngineConfig;
}

// We mock PipelineEngine to avoid real execution
vi.mock('../src/engine.js', () => ({
  PipelineEngine: vi.fn().mockImplementation(() => ({
    run: vi.fn(),
  })),
}));

describe('DirectEngineSpawner', () => {
  it('calls child engine.run() with correct args', async () => {
    const { PipelineEngine } = await import('../src/engine.js');
    const mockRun = vi.fn().mockResolvedValue(makeSuccessRun());
    (PipelineEngine as any).mockImplementation(() => ({ run: mockRun }));

    const spawner = new DirectEngineSpawner({} as EngineConfig);
    await spawner.spawnAndWait({
      pipeline: 'recipe-developer',
      input: { dish: 'pasta' },
      parentRunId: 'parent-1',
      depth: 1,
    });

    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        pipeline: 'recipe-developer',
        input: { dish: 'pasta' },
        parentRunId: 'parent-1',
        depth: 1,
      })
    );
  });

  it('returns run_id, status, and last stage output on success', async () => {
    const { PipelineEngine } = await import('../src/engine.js');
    const successRun = makeSuccessRun();
    (PipelineEngine as any).mockImplementation(() => ({
      run: vi.fn().mockResolvedValue(successRun),
    }));

    const spawner = new DirectEngineSpawner({} as EngineConfig);
    const result = await spawner.spawnAndWait({
      pipeline: 'test',
      input: {},
      parentRunId: 'p1',
      depth: 1,
    });

    expect(result.run_id).toBe('child-run-1');
    expect(result.status).toBe('success');
    expect(result.output).toEqual({ answer: 42 });
  });

  it('throws when child run fails', async () => {
    const { PipelineEngine } = await import('../src/engine.js');
    const failedRun = makeSuccessRun({ id: 'child-fail', status: 'failed', stages: [] });
    (PipelineEngine as any).mockImplementation(() => ({
      run: vi.fn().mockResolvedValue(failedRun),
    }));

    const spawner = new DirectEngineSpawner({} as EngineConfig);
    await expect(
      spawner.spawnAndWait({ pipeline: 'bad', input: {}, parentRunId: 'p1', depth: 1 })
    ).rejects.toThrow('Child run child-fail failed');
  });

  it('throws when child run is rejected', async () => {
    const { PipelineEngine } = await import('../src/engine.js');
    const rejectedRun = makeSuccessRun({ id: 'child-rej', status: 'rejected', stages: [] });
    (PipelineEngine as any).mockImplementation(() => ({
      run: vi.fn().mockResolvedValue(rejectedRun),
    }));

    const spawner = new DirectEngineSpawner({} as EngineConfig);
    await expect(
      spawner.spawnAndWait({ pipeline: 'qa', input: {}, parentRunId: 'p1', depth: 1 })
    ).rejects.toThrow('Child run child-rej rejected');
  });
});
```

**Step 2: Run to verify it fails**

```bash
pnpm --filter @studio-foundation/engine test -- --reporter=verbose direct-engine-spawner
```
Expected: FAIL with "Cannot find module".

**Step 3: Create `engine/src/spawners/direct-engine-spawner.ts`**

```typescript
import type { RunSpawner, SpawnConfig, SpawnResult, PipelineRun } from '@studio-foundation/contracts';
import { PipelineEngine, type EngineConfig } from '../engine.js';

export class DirectEngineSpawner implements RunSpawner {
  constructor(private engineConfig: EngineConfig) {}

  async spawnAndWait(config: SpawnConfig): Promise<SpawnResult> {
    const child = new PipelineEngine(this.engineConfig);
    const result: PipelineRun = await child.run({
      pipeline: config.pipeline,
      input: config.input,
      parentRunId: config.parentRunId,
      depth: config.depth,
    });

    if (result.status === 'failed' || result.status === 'rejected') {
      throw new Error(`Child run ${result.id} ${result.status}`);
    }

    // Extract output from the last successful stage
    const lastStage = [...result.stages].reverse().find(s => s.status === 'success');
    const output = (lastStage as { output?: unknown } | undefined)?.output ?? null;

    return { run_id: result.id, status: result.status, output };
  }
}
```

**Step 4: Run to verify tests pass**

```bash
pnpm --filter @studio-foundation/engine test -- --reporter=verbose direct-engine-spawner
```
Expected: 4 passing.

**Step 5: Build engine**

```bash
pnpm --filter @studio-foundation/engine build
```
Expected: success.

**Step 6: Commit**

```bash
git add engine/src/spawners/direct-engine-spawner.ts engine/tests/direct-engine-spawner.test.ts
git commit -m "feat(engine): DirectEngineSpawner — spawn child runs in-process"
```

---

### Task 7: engine — inject studio-run into per-run ToolRegistry

**Files:**
- Modify: `engine/src/engine.ts`

**Step 1: Add imports at top of `engine/src/engine.ts`**

```typescript
import { createStudioRunTool, STUDIO_RUN_PROMPT_SNIPPET } from '@studio-foundation/runner';
```

**Step 2: In `engine.run()`, after creating `pipelineRun` (around line 188), add per-run registry**

Find the block that creates `pipelineRun` and right after `this.config.db?.savePipelineRun(pipelineRun);`, add:

```typescript
// Build per-run tool registry — cloned so studio-run can carry run-specific context
const runToolRegistry = this.config.spawner
  ? (() => {
      const registry = this.config.toolRegistry.clone();
      registry.registerPlugin(
        'studio_run',
        createStudioRunTool({
          spawner: this.config.spawner,
          currentRunId: pipelineRun.id,
          currentDepth: input.depth ?? 0,
          maxDepth: this.config.maxDepth ?? 3,
        }),
        STUDIO_RUN_PROMPT_SNIPPET
      );
      return registry;
    })()
  : this.config.toolRegistry;
```

**Step 3: Replace `this.config.toolRegistry` with `runToolRegistry` in `runAgent` calls**

In `executeStage()`, find where `runAgent` is called. The `toolRegistry` parameter comes from the engine config. Change it to use `runToolRegistry`.

The `executeStage` method receives its params from `engine.run()`. The simplest way is to pass `runToolRegistry` as a parameter to `executeStage`. Add it to the `executeStage` signature:

```typescript
private async executeStage(
  stageDef: StageDefinition,
  pipelineContext: PipelineContext,
  stageIndex: number,
  totalStages: number,
  input: Record<string, unknown>,
  paths: ProjectPaths,
  runMiddleware: AnonymizationMiddleware | null,
  runId: string,
  toolRegistry: ToolRegistry,   // ← add this parameter
  signal?: AbortSignal,
): Promise<StageResult>
```

Then in the `runAgent` call inside `executeStage`, use the passed `toolRegistry` instead of `this.config.toolRegistry`.

Update all call sites of `executeStage` in `engine.run()` to pass `runToolRegistry`.

Do the same for `runGroup()` if it also calls `executeStage`.

**Step 4: Also propagate `parentRunId` and `depth` to `PipelineRun`**

In `engine.run()`, when constructing `pipelineRun`:

```typescript
const pipelineRun: PipelineRun = {
  id: input.id ?? randomUUID(),
  pipeline_name: pipeline.name,
  status: 'running',
  started_at: new Date().toISOString(),
  stages: [],
  ...(input.parentRunId ? { parent_run_id: input.parentRunId } : {}),
};
```

**Step 5: Build engine**

```bash
pnpm --filter @studio-foundation/engine build
```
Expected: success. Fix any TypeScript errors around the toolRegistry parameter threading.

**Step 6: Run engine tests**

```bash
pnpm --filter @studio-foundation/engine test
```
Expected: all existing tests still pass.

**Step 7: Commit**

```bash
git add engine/src/engine.ts
git commit -m "feat(engine): inject studio-run tool into per-run ToolRegistry when spawner configured"
```

---

### Task 8: api — read depth/parent headers + extend `LaunchConfig`

**Files:**
- Modify: `api/src/routes/runs.ts`
- Modify: `api/src/launcher.ts`
- Test: `api/tests/runs.test.ts`

**Step 1: Write failing test**

Open `api/tests/runs.test.ts`. Find the POST /api/runs test block and add:

```typescript
it('passes X-Studio-Depth and X-Studio-Parent-Run-Id headers to launcher', async () => {
  const launchSpy = vi.spyOn(launcher, 'launch').mockResolvedValue({ run_id: 'r1' });
  const res = await server.inject({
    method: 'POST',
    url: '/api/runs',
    headers: {
      'content-type': 'application/json',
      'x-studio-depth': '2',
      'x-studio-parent-run-id': 'parent-abc',
    },
    payload: { pipeline: 'test', input: {} },
  });
  expect(res.statusCode).toBe(201);
  expect(launchSpy).toHaveBeenCalledWith(
    expect.objectContaining({ depth: 2, parentRunId: 'parent-abc' })
  );
});
```

**Step 2: Run to verify it fails**

```bash
pnpm --filter @studio-foundation/api test -- --reporter=verbose runs
```
Expected: FAIL — launcher not called with depth/parentRunId.

**Step 3: Extend `LaunchConfig` in `launcher.ts`**

Find `export interface LaunchConfig` and add:

```typescript
export interface LaunchConfig {
  runId: string;
  pipeline: string;
  input: Record<string, unknown>;
  configsDir: string;
  providerOverride?: string;
  depth?: number;           // ← add
  parentRunId?: string;     // ← add
}
```

In `InProcessLauncher.launch()`, pass these to `engine.run()`:

```typescript
void engine
  .run({
    pipeline,
    input,
    signal: controller.signal,
    id: runId,
    depth: config.depth,           // ← add
    parentRunId: config.parentRunId, // ← add
  })
```

**Step 4: Read headers in `api/src/routes/runs.ts`**

In the POST `/runs` handler, after destructuring `request.body`, add:

```typescript
const depth = parseInt((request.headers['x-studio-depth'] as string) ?? '0', 10) || 0;
const parentRunId = request.headers['x-studio-parent-run-id'] as string | undefined;
```

Then pass to `launcher.launch()`:

```typescript
await launcher.launch({
  runId,
  pipeline,
  input,
  configsDir: options.deps.configsDir,
  providerOverride: provider,
  depth,           // ← add
  parentRunId,     // ← add
});
```

**Step 5: Run to verify test passes**

```bash
pnpm --filter @studio-foundation/api test -- --reporter=verbose runs
```
Expected: new test passes. Existing tests still pass.

**Step 6: Commit**

```bash
git add api/src/routes/runs.ts api/src/launcher.ts api/tests/runs.test.ts
git commit -m "feat(api): read X-Studio-Depth and X-Studio-Parent-Run-Id headers on POST /api/runs"
```

---

### Task 9: api — `HttpApiSpawner`

**Files:**
- Create: `api/src/spawners/http-api-spawner.ts`
- Test: `api/tests/http-api-spawner.test.ts`

**Step 1: Write failing tests**

Create `api/tests/http-api-spawner.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpApiSpawner } from '../src/spawners/http-api-spawner.js';

// Helper: create a fake SSE stream that emits one event then closes
function makeFakeSseResponse(events: Array<{ type: string; data: unknown }>) {
  const lines: string[] = [];
  for (const e of events) {
    lines.push(`event: ${e.type}`);
    lines.push(`data: ${JSON.stringify(e.data)}`);
    lines.push('');
  }
  const body = lines.join('\n');
  const encoder = new TextEncoder();
  const encoded = encoder.encode(body);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('HttpApiSpawner', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('POSTs to /api/runs with correct headers and body', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run_id: 'child-1', status: 'running', stream_url: '/api/runs/child-1/stream' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        makeFakeSseResponse([{ type: 'pipeline_complete', data: { status: 'success', run_id: 'child-1' } }])
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'child-1',
            pipeline_name: 'test',
            status: 'success',
            started_at: new Date().toISOString(),
            stages: [{ id: 's1', stage_name: 'final', status: 'success', started_at: '', tasks: [], output: { ok: true } }],
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      );

    const spawner = new HttpApiSpawner('http://localhost:3000');
    await spawner.spawnAndWait({ pipeline: 'test', input: { x: 1 }, parentRunId: 'p1', depth: 1 });

    const postCall = fetchMock.mock.calls[0];
    expect(postCall[0]).toBe('http://localhost:3000/api/runs');
    expect(postCall[1].method).toBe('POST');
    expect(postCall[1].headers['X-Studio-Depth']).toBe('1');
    expect(postCall[1].headers['X-Studio-Parent-Run-Id']).toBe('p1');
  });

  it('returns run_id, status, and output from last stage on success', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run_id: 'child-2', status: 'running', stream_url: '' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        makeFakeSseResponse([{ type: 'pipeline_complete', data: { status: 'success', run_id: 'child-2' } }])
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'child-2',
            pipeline_name: 'p',
            status: 'success',
            started_at: '',
            stages: [{ id: 's1', stage_name: 'final', status: 'success', started_at: '', tasks: [], output: { recipe: 'pasta' } }],
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      );

    const spawner = new HttpApiSpawner('http://localhost:3000');
    const result = await spawner.spawnAndWait({ pipeline: 'p', input: {}, parentRunId: 'x', depth: 1 });

    expect(result.run_id).toBe('child-2');
    expect(result.status).toBe('success');
    expect(result.output).toEqual({ recipe: 'pasta' });
  });

  it('throws when pipeline_complete has failed status', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run_id: 'child-3', status: 'running', stream_url: '' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        makeFakeSseResponse([{ type: 'pipeline_complete', data: { status: 'failed', run_id: 'child-3' } }])
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'child-3', pipeline_name: 'p', status: 'failed', started_at: '', stages: [] }),
          { headers: { 'content-type': 'application/json' } }
        )
      );

    const spawner = new HttpApiSpawner('http://localhost:3000');
    await expect(
      spawner.spawnAndWait({ pipeline: 'bad', input: {}, parentRunId: 'x', depth: 1 })
    ).rejects.toThrow('Child run child-3 failed');
  });
});
```

**Step 2: Run to verify it fails**

```bash
pnpm --filter @studio-foundation/api test -- --reporter=verbose http-api-spawner
```
Expected: FAIL with "Cannot find module".

**Step 3: Create `api/src/spawners/http-api-spawner.ts`**

```typescript
import type { RunSpawner, SpawnConfig, SpawnResult, PipelineRun } from '@studio-foundation/contracts';

export class HttpApiSpawner implements RunSpawner {
  constructor(private apiUrl: string) {}

  async spawnAndWait(config: SpawnConfig): Promise<SpawnResult> {
    // 1. Launch the run
    const postRes = await fetch(`${this.apiUrl}/api/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Studio-Depth': String(config.depth),
        'X-Studio-Parent-Run-Id': config.parentRunId,
      },
      body: JSON.stringify({ pipeline: config.pipeline, input: config.input }),
    });

    if (!postRes.ok) {
      const text = await postRes.text();
      throw new Error(`Failed to launch child run: ${postRes.status} ${text}`);
    }

    const { run_id } = (await postRes.json()) as { run_id: string };

    // 2. Wait for pipeline_complete via SSE
    await this.waitForCompletion(run_id);

    // 3. Fetch full run result to get output
    const getRes = await fetch(`${this.apiUrl}/api/runs/${run_id}`);
    const run = (await getRes.json()) as PipelineRun;

    if (run.status === 'failed' || run.status === 'rejected') {
      throw new Error(`Child run ${run_id} ${run.status}`);
    }

    const lastStage = [...run.stages].reverse().find(s => s.status === 'success');
    const output = (lastStage as { output?: unknown } | undefined)?.output ?? null;

    return { run_id, status: run.status, output };
  }

  private waitForCompletion(runId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      fetch(`${this.apiUrl}/api/runs/${runId}/stream`, {
        headers: { Accept: 'text/event-stream' },
      })
        .then(response => {
          if (!response.ok || !response.body) {
            reject(new Error(`SSE connection failed for run ${runId}: ${response.status}`));
            return;
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let currentEventType = '';

          const pump = (): Promise<void> =>
            reader.read().then(({ done, value }) => {
              if (done) {
                reject(new Error(`SSE stream ended without pipeline_complete for run ${runId}`));
                return;
              }
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';

              for (const line of lines) {
                if (line.startsWith('event: ')) {
                  currentEventType = line.slice(7).trim();
                } else if (line.startsWith('data: ') && currentEventType === 'pipeline_complete') {
                  reader.cancel();
                  resolve();
                  return;
                } else if (line === '') {
                  currentEventType = '';
                }
              }
              return pump();
            });

          pump().catch(reject);
        })
        .catch(reject);
    });
  }
}
```

**Step 4: Run to verify tests pass**

```bash
pnpm --filter @studio-foundation/api test -- --reporter=verbose http-api-spawner
```
Expected: 3 passing.

**Step 5: Build api**

```bash
pnpm --filter @studio-foundation/api build
```
Expected: success.

**Step 6: Commit**

```bash
git add api/src/spawners/http-api-spawner.ts api/tests/http-api-spawner.test.ts
git commit -m "feat(api): HttpApiSpawner — spawn child runs via HTTP + SSE wait"
```

---

### Task 10: api — wire `HttpApiSpawner` in bootstrap

**Files:**
- Modify: `api/src/bootstrap.ts`

**Step 1: Add import at top of `bootstrap.ts`**

```typescript
import { HttpApiSpawner } from './spawners/http-api-spawner.js';
```

**Step 2: Create spawner and add to engineConfig**

In `bootstrap.ts`, find where `engineConfig` is assembled (the object passed to `InProcessLauncher`). Add:

```typescript
// Determine the API URL for self-referential spawning (studio-run tool)
// Uses the configured host/port or defaults to localhost:3000
const apiPort = options?.port ?? 3000;
const apiHost = options?.host ?? 'localhost';
const spawner = new HttpApiSpawner(`http://${apiHost}:${apiPort}`);

const engineConfig: EngineConfig = {
  configsDir: studioDir,
  providerRegistry,
  toolRegistry,
  db: store,
  pluginSkills,
  spawner,           // ← add
  maxDepth: 3,       // ← add
};
```

Note: if `bootstrap.ts` doesn't have `options?.port`, use the default `3000`. Check the actual bootstrap signature and adapt accordingly.

**Step 3: Build api**

```bash
pnpm --filter @studio-foundation/api build
```
Expected: success. Fix any TypeScript errors.

**Step 4: Run api tests**

```bash
pnpm --filter @studio-foundation/api test
```
Expected: all existing tests still pass (5 failures are pre-existing, not new).

**Step 5: Commit**

```bash
git add api/src/bootstrap.ts
git commit -m "feat(api): wire HttpApiSpawner into engine config at bootstrap"
```

---

### Task 11: cli — wire `DirectEngineSpawner`

**Files:**
- Modify: `cli/src/commands/run.ts`

**Step 1: Add import at top of `run.ts`**

```typescript
import { DirectEngineSpawner } from '@studio-foundation/engine';
```

Note: check if `DirectEngineSpawner` is exported from `engine/src/index.ts`. If not, add it:

```typescript
// In engine/src/index.ts
export { DirectEngineSpawner } from './spawners/direct-engine-spawner.js';
```

**Step 2: Add spawner to engine config in `run.ts`**

Find the block where `PipelineEngine` is constructed (around line 391):

```typescript
const engineConfig = {
  configsDir,
  repoPath,
  providerRegistry,
  toolRegistry,
  pluginSkills,
  db: runStore ?? undefined,
  ...(options.provider ? { providerOverride: options.provider } : {}),
};

const spawner = new DirectEngineSpawner(engineConfig);

const engine = new PipelineEngine(
  {
    ...engineConfig,
    spawner,     // ← add
    maxDepth: 3, // ← add
  },
  events
);
```

**Step 3: Build cli**

```bash
pnpm --filter @studio-foundation/cli build
```
Expected: success.

**Step 4: Commit**

```bash
git add cli/src/commands/run.ts engine/src/index.ts
git commit -m "feat(cli): wire DirectEngineSpawner into PipelineEngine config"
```

---

### Task 12: Final build + full test suite

**Step 1: Build everything from root**

```bash
pnpm build
```
Expected: all 7 packages build successfully.

**Step 2: Run full test suite**

```bash
pnpm test
```
Expected: all new tests pass. Pre-existing failures in api (5 tests) are unchanged.

**Step 3: Smoke test with mock provider (optional but recommended)**

If you have a project with `.studio/` set up, verify the tool appears:
```bash
# In a project directory
studio tools list
# Should show: studio_run-run_pipeline
```

**Step 4: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore: final build verification for STU-105"
```

---

## Summary of files changed

| Package | Files |
|---|---|
| `contracts` | `src/spawner.ts` (new), `src/run.ts`, `src/index.ts` |
| `engine` | `src/engine.ts`, `src/state/run-store.ts`, `src/spawners/direct-engine-spawner.ts` (new), `src/index.ts` |
| `runner` | `src/tools/tool-registry.ts`, `src/tools/builtin/studio-run.ts` (new), `src/index.ts` |
| `api` | `src/routes/runs.ts`, `src/launcher.ts`, `src/bootstrap.ts`, `src/spawners/http-api-spawner.ts` (new) |
| `cli` | `src/commands/run.ts` |
