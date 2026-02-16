# Feedback Loop Groups Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable pipeline groups that loop stages (code-generation → qa-review) with feedback until QA approves or max iterations exhausted.

**Architecture:** A `StageGroup` entry in the pipeline stages array wraps 2+ stages into a feedback loop. The last stage is the gate — if its post-validator returns `rejected`, the group restarts from the first stage with QA feedback injected into context. Group stage outputs are cleared between iterations; pre-group outputs persist.

**Tech Stack:** TypeScript, Vitest, js-yaml, @studio/contracts, @studio/engine

---

### Task 1: Add group types to contracts

**Files:**
- Modify: `contracts/src/pipeline.ts`

**Step 1: Write the type additions**

Add after the existing `StageDefinition` interface (line 31):

```typescript
// A pipeline entry is either a stage or a group of stages
export type PipelineEntry = StageDefinition | StageGroup;

export interface StageGroup {
  group: string;
  max_iterations: number;
  stages: StageDefinition[];
}

export function isStageGroup(entry: PipelineEntry): entry is StageGroup {
  return 'group' in entry && 'stages' in entry;
}
```

Change `PipelineDefinition.stages` type from `StageDefinition[]` to `PipelineEntry[]` (line 13).

**Step 2: Build contracts**

Run: `cd contracts && npm run build`
Expected: Clean compilation, no errors

**Step 3: Commit**

```bash
git add contracts/src/pipeline.ts
git commit -m "feat(contracts): add StageGroup, PipelineEntry, isStageGroup types"
```

---

### Task 2: Update pipeline loader to parse groups

**Files:**
- Modify: `engine/src/pipeline/loader.ts`
- Modify: `engine/tests/loader.test.ts`

**Step 1: Write the failing test**

Add to `engine/tests/loader.test.ts` inside the `parsePipelineYaml` describe block:

```typescript
import { isStageGroup } from '@studio/contracts';

it('parses a pipeline with a group entry', () => {
  const yamlContent = `
name: grouped-pipeline
description: Pipeline with a group
version: 2
stages:
  - name: analysis
    kind: analysis
    agent: analyst
  - group: review-loop
    max_iterations: 3
    stages:
      - name: code-gen
        kind: code_generation
        agent: coder
      - name: qa
        kind: qa
        agent: analyst
`;
  const pipeline = parsePipelineYaml(yamlContent);
  expect(pipeline.stages).toHaveLength(2);

  // First entry is a regular stage
  const first = pipeline.stages[0];
  expect(isStageGroup(first)).toBe(false);
  expect((first as any).name).toBe('analysis');

  // Second entry is a group
  const second = pipeline.stages[1];
  expect(isStageGroup(second)).toBe(true);
  if (isStageGroup(second)) {
    expect(second.group).toBe('review-loop');
    expect(second.max_iterations).toBe(3);
    expect(second.stages).toHaveLength(2);
    expect(second.stages[0].name).toBe('code-gen');
    expect(second.stages[1].name).toBe('qa');
  }
});

it('defaults max_iterations to 3 when not specified', () => {
  const yamlContent = `
name: default-iters
version: 1
stages:
  - group: loop
    stages:
      - name: s1
        kind: analysis
        agent: a
      - name: s2
        kind: qa
        agent: a
`;
  const pipeline = parsePipelineYaml(yamlContent);
  const g = pipeline.stages[0];
  expect(isStageGroup(g)).toBe(true);
  if (isStageGroup(g)) {
    expect(g.max_iterations).toBe(3);
  }
});

it('throws when a group has no stages', () => {
  const yamlContent = `
name: bad-group
version: 1
stages:
  - group: empty-loop
    stages: []
`;
  expect(() => parsePipelineYaml(yamlContent)).toThrow('at least 2 stages');
});

it('throws when a group has only 1 stage', () => {
  const yamlContent = `
name: bad-group
version: 1
stages:
  - group: solo-loop
    stages:
      - name: only-one
        kind: analysis
        agent: a
`;
  expect(() => parsePipelineYaml(yamlContent)).toThrow('at least 2 stages');
});
```

**Step 2: Run tests to verify they fail**

Run: `cd engine && npx vitest run tests/loader.test.ts`
Expected: 4 new tests FAIL (parsePipelineYaml doesn't understand groups yet; group entries hit the stage validation `missing 'name'` error)

**Step 3: Update the loader to parse groups**

In `engine/src/pipeline/loader.ts`, update the imports:

```typescript
import type { PipelineDefinition, PipelineEntry, StageGroup, StageDefinition } from '@studio/contracts';
import { isStageGroup } from '@studio/contracts';
```

Replace the validation loop (lines 47-51) and the return cast (line 53) in `parsePipelineYaml`:

```typescript
  const stages: PipelineEntry[] = [];
  for (const entry of parsed.stages as any[]) {
    if (entry.group) {
      // Group entry
      if (!Array.isArray(entry.stages) || entry.stages.length < 2) {
        throw new Error(`Group '${entry.group}' must have at least 2 stages${context}`);
      }
      for (const s of entry.stages) {
        validateStageFields(s, context);
      }
      stages.push({
        group: entry.group,
        max_iterations: entry.max_iterations ?? 3,
        stages: entry.stages,
      } as StageGroup);
    } else {
      // Simple stage
      validateStageFields(entry, context);
      stages.push(entry as StageDefinition);
    }
  }

  return {
    ...parsed,
    stages,
  } as unknown as PipelineDefinition;
```

Extract the field validation into a helper at the bottom of the file:

```typescript
function validateStageFields(stage: any, context: string): void {
  if (!stage.name) throw new Error(`Stage missing 'name'${context}`);
  if (!stage.kind) throw new Error(`Stage '${stage.name}' missing 'kind'${context}`);
  if (!stage.agent) throw new Error(`Stage '${stage.name}' missing 'agent'${context}`);
}
```

**Step 4: Run tests to verify they pass**

Run: `cd engine && npx vitest run tests/loader.test.ts`
Expected: All tests PASS (existing + 4 new)

**Step 5: Also update the `loadPipeline — real files` test**

The test at line 114 checks `pipeline.stages.length >= 4`. After we update the YAML in Task 7, the pipeline will have 3 entries (2 stages + 1 group). But we're not changing the YAML yet, so this test still passes for now. No change needed yet.

**Step 6: Commit**

```bash
git add engine/src/pipeline/loader.ts engine/tests/loader.test.ts
git commit -m "feat(engine): parse stage groups in pipeline loader"
```

---

### Task 3: Add group feedback to context propagation

**Files:**
- Modify: `engine/src/pipeline/context-propagation.ts`
- Modify: `engine/tests/context-propagation.test.ts`

**Step 1: Write the failing tests**

Add to `engine/tests/context-propagation.test.ts`:

```typescript
import {
  createInitialContext,
  addStageOutput,
  getContextForStage,
  setGroupFeedback,
  clearGroupFeedback,
  type GroupFeedback,
} from '../src/pipeline/context-propagation.js';

describe('group feedback', () => {
  it('setGroupFeedback adds feedback to context', () => {
    const ctx = createInitialContext('test');
    const feedback: GroupFeedback = {
      iteration: 1,
      max_iterations: 3,
      rejection_reason: 'Missing error handling',
    };
    setGroupFeedback(ctx, feedback);
    expect(ctx.groupFeedback).toEqual(feedback);
  });

  it('clearGroupFeedback removes feedback from context', () => {
    const ctx = createInitialContext('test');
    setGroupFeedback(ctx, {
      iteration: 1,
      max_iterations: 3,
      rejection_reason: 'test',
    });
    clearGroupFeedback(ctx);
    expect(ctx.groupFeedback).toBeUndefined();
  });

  it('getContextForStage injects group_feedback into additional_context', () => {
    const ctx = createInitialContext('Build a FAQ');
    setGroupFeedback(ctx, {
      iteration: 1,
      max_iterations: 3,
      rejection_reason: 'Props not passed to component',
      rejection_details: ['Missing onClick handler', 'Wrong prop type'],
    });

    const stage = makeStage({
      context: { include: ['input', 'group_feedback'] },
    });
    const agentCtx = getContextForStage(ctx, stage);

    expect(agentCtx.additional_context).toContain('Build a FAQ');
    expect(agentCtx.additional_context).toContain('QA FEEDBACK');
    expect(agentCtx.additional_context).toContain('Iteration 2/3');
    expect(agentCtx.additional_context).toContain('Props not passed to component');
    expect(agentCtx.additional_context).toContain('Missing onClick handler');
    expect(agentCtx.additional_context).toContain('Wrong prop type');
    expect(agentCtx.additional_context).toContain('MUST fix ALL issues');
  });

  it('group_feedback is ignored when no feedback is set', () => {
    const ctx = createInitialContext('Build a FAQ');
    const stage = makeStage({
      context: { include: ['input', 'group_feedback'] },
    });
    const agentCtx = getContextForStage(ctx, stage);

    // Only input is present, no feedback text
    expect(agentCtx.additional_context).toBe('Build a FAQ');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd engine && npx vitest run tests/context-propagation.test.ts`
Expected: FAIL — `setGroupFeedback` and `clearGroupFeedback` don't exist, `group_feedback` case not handled

**Step 3: Implement group feedback in context propagation**

In `engine/src/pipeline/context-propagation.ts`, add the `GroupFeedback` interface and `groupFeedback` field to `PipelineContext`:

```typescript
export interface GroupFeedback {
  iteration: number;
  max_iterations: number;
  rejection_reason: string;
  rejection_details?: string[];
}

export interface PipelineContext {
  input: PipelineInput;
  stageOutputs: Map<string, unknown>;
  repoPath?: string;
  groupFeedback?: GroupFeedback;
}
```

Add the mutation helpers after `addStageOutput`:

```typescript
export function setGroupFeedback(
  context: PipelineContext,
  feedback: GroupFeedback
): void {
  context.groupFeedback = feedback;
}

export function clearGroupFeedback(context: PipelineContext): void {
  context.groupFeedback = undefined;
}
```

Add the `group_feedback` case in `getContextForStage`, inside the `for` loop's switch:

```typescript
      case 'group_feedback':
        if (context.groupFeedback) {
          const fb = context.groupFeedback;
          const lines = [
            `\n## QA FEEDBACK (Iteration ${fb.iteration + 1}/${fb.max_iterations})`,
            ``,
            `Your previous implementation was REJECTED by QA review.`,
            `Reason: ${fb.rejection_reason}`,
          ];

          if (fb.rejection_details?.length) {
            lines.push(``, `Issues to fix:`);
            for (const detail of fb.rejection_details) {
              lines.push(`  - ${detail}`);
            }
          }

          lines.push(
            ``,
            `You MUST fix ALL issues listed above.`,
            `Read the current files, apply the corrections, and write the fixed versions.`,
            `Do NOT rewrite everything from scratch — make targeted fixes.`
          );

          agentContext.additional_context =
            (agentContext.additional_context || '') + '\n' + lines.join('\n');
        }
        break;
```

Note: `iteration` is 0-indexed internally (the loop counter starts at 0), but displayed as `iteration + 1` for human-readable output. This way iteration=0 means "first run" (no feedback), iteration=1 displays as "Iteration 2/3".

**Step 4: Run tests to verify they pass**

Run: `cd engine && npx vitest run tests/context-propagation.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add engine/src/pipeline/context-propagation.ts engine/tests/context-propagation.test.ts
git commit -m "feat(engine): add group feedback to context propagation"
```

---

### Task 4: Add group events

**Files:**
- Modify: `engine/src/events.ts`
- Modify: `engine/src/index.ts`

**Step 1: Add group event types to events.ts**

After `StageRetryEvent` (line 56), add:

```typescript
export interface GroupStartEvent {
  group_name: string;
  max_iterations: number;
}

export interface GroupIterationEvent {
  group_name: string;
  iteration: number;
  max_iterations: number;
}

export interface GroupFeedbackEvent {
  group_name: string;
  iteration: number;
  rejection_reason: string;
  rejection_details: string[];
}

export interface GroupCompleteEvent {
  group_name: string;
  iterations: number;
  status: string;
}
```

Add to the `EngineEvents` interface (after `onTaskRetry`):

```typescript
  onGroupStart?: (event: GroupStartEvent) => void;
  onGroupIteration?: (event: GroupIterationEvent) => void;
  onGroupFeedback?: (event: GroupFeedbackEvent) => void;
  onGroupComplete?: (event: GroupCompleteEvent) => void;
```

Add to the `PipelineEvent` union:

```typescript
  | { type: 'group_start'; groupName: string; maxIterations: number }
  | { type: 'group_iteration'; groupName: string; iteration: number; maxIterations: number }
  | { type: 'group_feedback'; groupName: string; iteration: number; rejectionReason: string }
  | { type: 'group_complete'; groupName: string; iterations: number; status: string };
```

**Step 2: Export new types from engine/src/index.ts**

Add to the events export block:

```typescript
export type {
  // ... existing exports ...
  GroupStartEvent,
  GroupIterationEvent,
  GroupFeedbackEvent,
  GroupCompleteEvent,
} from './events.js';
```

**Step 3: Build engine to verify**

Run: `cd engine && npm run build`
Expected: Clean compilation

**Step 4: Commit**

```bash
git add engine/src/events.ts engine/src/index.ts
git commit -m "feat(engine): add group lifecycle event types"
```

---

### Task 5: Refactor engine — extract executeStage return type

**Files:**
- Modify: `engine/src/engine.ts`

This is a pure refactoring step. The existing `executeStage()` method returns `Promise<StageRun>`, but `runGroup()` needs additional metadata (post-validation result, status). We add a richer return type to `executeStage` while keeping backward compatibility in `run()`.

**Step 1: Add StageResult interface and modify executeStage return**

At the top of `engine/src/engine.ts`, add after the `RunInput` interface:

```typescript
interface StageResult {
  stageRun: StageRun;
  status: string;
  postValidation?: PostValidationResult;
  lastAgentOutput?: unknown;
}
```

Change `executeStage` return type from `Promise<StageRun>` to `Promise<StageResult>` and update the return statement at line 415:

```typescript
    return {
      stageRun: stageRun,
      status: stageStatus,
      postValidation: postResult,
      lastAgentOutput: lastResult?.output,
    };
```

Update `run()` to destructure the result. Replace lines 165-198 (the `executeStage` call and everything that uses `stageRun` up to `previousStageName = stageDef.name`):

```typescript
      const result = await this.executeStage(
        stageDef,
        pipelineContext,
        previousStageName,
        input.input,
        i,
        pipeline.stages.length,
      );

      pipelineRun.stages.push(result.stageRun);

      if (result.status === 'failed' || result.status === 'rejected') {
        pipelineRun.status = result.stageRun.status;
        pipelineRun.completed_at = new Date().toISOString();
        this.events?.onPipelineComplete?.({
          pipeline_name: pipeline.name,
          run_id: pipelineRun.id,
          status: pipelineRun.status,
          duration_ms: Date.now() - pipelineStartTime,
          total_tokens: this.pipelineTotals.tokens,
          total_tool_calls: this.pipelineTotals.toolCalls,
        });
        this.emitter.emit({ type: 'pipeline_complete', pipelineId: pipelineRun.id });
        this.config.db?.savePipelineRun(pipelineRun);
        return pipelineRun;
      }

      if (result.lastAgentOutput !== undefined) {
        addStageOutput(pipelineContext, stageDef.name, result.lastAgentOutput);
      }

      previousStageName = stageDef.name;
```

**Step 2: Run existing tests to verify refactor is clean**

Run: `cd engine && npx vitest run tests/engine.test.ts`
Expected: All existing tests PASS (behavior unchanged)

**Step 3: Commit**

```bash
git add engine/src/engine.ts
git commit -m "refactor(engine): extract StageResult from executeStage for group reuse"
```

---

### Task 6: Implement runGroup and update run() to handle groups

**Files:**
- Modify: `engine/src/engine.ts`
- Create: `engine/tests/group-loop.test.ts`

**Step 1: Write failing tests for group execution**

Create `engine/tests/group-loop.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { PipelineEngine, type EngineConfig } from '../src/engine.js';
import { InMemoryRunStore } from '../src/state/run-store.js';
import type { EngineEvents } from '../src/events.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');
const PIPELINES_DIR = join(FIXTURES_DIR, 'pipelines');
const AGENTS_DIR = join(FIXTURES_DIR, 'agents');
const CONTRACTS_DIR = join(FIXTURES_DIR, 'contracts');

// Ensure fixture dirs exist (shared with engine.test.ts)
mkdirSync(PIPELINES_DIR, { recursive: true });
mkdirSync(AGENTS_DIR, { recursive: true });
mkdirSync(CONTRACTS_DIR, { recursive: true });

// Agent fixture (reuse existing)
writeFileSync(join(AGENTS_DIR, 'test-agent.agent.yaml'), `
name: test-agent
provider: anthropic
model: claude-sonnet-4-20250514
temperature: 0.3
`);

// Contract with approval gate for QA
writeFileSync(join(CONTRACTS_DIR, 'qa-gate.contract.yaml'), `
name: qa-gate
version: 1
schema:
  required_fields:
    - status
    - issues
approval:
  status_field: status
  accepted_values:
    - approved
    - pass
`);

// Contract without approval (for code-gen stage)
writeFileSync(join(CONTRACTS_DIR, 'code-gen.contract.yaml'), `
name: code-gen
version: 1
schema:
  required_fields:
    - files_changed
`);

// Pipeline with a group
writeFileSync(join(PIPELINES_DIR, 'group-test.pipeline.yaml'), `
name: group-test
description: Test pipeline with a feedback loop group
version: 2
stages:
  - name: analysis
    kind: analysis
    agent: test-agent
    ralph:
      max_attempts: 1
      retry_strategy: none
    context:
      include:
        - input
  - group: impl-review
    max_iterations: 3
    stages:
      - name: code-gen
        kind: code_generation
        agent: test-agent
        contract: code-gen
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
            - all_stage_outputs
            - group_feedback
      - name: qa-review
        kind: qa
        agent: test-agent
        contract: qa-gate
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
            - all_stage_outputs
`);

function createMockProvider(callFn: (...args: any[]) => any) {
  return {
    name: 'anthropic',
    call: vi.fn(callFn),
  };
}

function createMockToolRegistry() {
  return {
    register: vi.fn(),
    get: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    list: vi.fn().mockReturnValue([]),
    toToolDefinitions: vi.fn().mockReturnValue([]),
    filter: vi.fn().mockReturnThis(),
  };
}

function createEngine(provider: any, events?: EngineEvents): PipelineEngine {
  return new PipelineEngine(
    {
      pipelinesDir: PIPELINES_DIR,
      agentsDir: AGENTS_DIR,
      contractsDir: CONTRACTS_DIR,
      providerRegistry: { get: vi.fn().mockReturnValue(provider), register: vi.fn() } as any,
      toolRegistry: createMockToolRegistry() as any,
      db: new InMemoryRunStore(),
    },
    events
  );
}

// Response helpers
function analysisResponse() {
  return {
    content: JSON.stringify({
      summary: 'Analysis done',
      requirements: ['r1'],
      acceptance_criteria: ['ac1'],
    }),
    tool_calls: [],
    finish_reason: 'stop',
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

function codeGenResponse() {
  return {
    content: JSON.stringify({
      files_changed: ['src/app.ts'],
    }),
    tool_calls: [],
    finish_reason: 'stop',
    usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
  };
}

function qaApproveResponse() {
  return {
    content: JSON.stringify({
      status: 'approved',
      issues: [],
    }),
    tool_calls: [],
    finish_reason: 'stop',
    usage: { prompt_tokens: 150, completion_tokens: 50, total_tokens: 200 },
  };
}

function qaRejectResponse(reason: string, issues: string[]) {
  return {
    content: JSON.stringify({
      status: 'needs_changes',
      summary: reason,
      issues,
    }),
    tool_calls: [],
    finish_reason: 'stop',
    usage: { prompt_tokens: 150, completion_tokens: 50, total_tokens: 200 },
  };
}

describe('Group feedback loop', () => {
  it('succeeds on first iteration when QA approves', async () => {
    let callCount = 0;
    const provider = createMockProvider(() => {
      callCount++;
      if (callCount === 1) return analysisResponse();
      if (callCount === 2) return codeGenResponse();
      return qaApproveResponse();
    });

    const engine = createEngine(provider);
    const result = await engine.run({ pipeline: 'group-test', input: 'Build feature' });

    expect(result.status).toBe('success');
    // 3 stage runs: analysis + code-gen + qa-review
    expect(result.stages).toHaveLength(3);
    expect(result.stages[0].stage_name).toBe('analysis');
    expect(result.stages[1].stage_name).toBe('code-gen');
    expect(result.stages[2].stage_name).toBe('qa-review');
    expect(provider.call).toHaveBeenCalledTimes(3);
  });

  it('succeeds on second iteration after QA rejection', async () => {
    let callCount = 0;
    const provider = createMockProvider(() => {
      callCount++;
      if (callCount === 1) return analysisResponse();    // analysis
      if (callCount === 2) return codeGenResponse();      // code-gen iter 1
      if (callCount === 3) return qaRejectResponse(       // qa rejects iter 1
        'Missing error handling',
        ['No try-catch around API call', 'Missing null check']
      );
      if (callCount === 4) return codeGenResponse();      // code-gen iter 2
      return qaApproveResponse();                          // qa approves iter 2
    });

    const engine = createEngine(provider);
    const result = await engine.run({ pipeline: 'group-test', input: 'Build feature' });

    expect(result.status).toBe('success');
    // 5 stage runs: analysis + (code-gen + qa) × 2
    expect(result.stages).toHaveLength(5);
    expect(provider.call).toHaveBeenCalledTimes(5);
  });

  it('rejects after max_iterations exhausted', async () => {
    let callCount = 0;
    const provider = createMockProvider(() => {
      callCount++;
      if (callCount === 1) return analysisResponse();
      // Alternate code-gen / qa-reject forever
      if (callCount % 2 === 0) return codeGenResponse();
      return qaRejectResponse('Still broken', ['Issue persists']);
    });

    const engine = createEngine(provider);
    const result = await engine.run({ pipeline: 'group-test', input: 'Build feature' });

    expect(result.status).toBe('rejected');
    // 1 analysis + 3 × (code-gen + qa) = 7
    expect(result.stages).toHaveLength(7);
    expect(provider.call).toHaveBeenCalledTimes(7);
  });

  it('fails immediately on technical failure in group', async () => {
    let callCount = 0;
    const provider = createMockProvider(() => {
      callCount++;
      if (callCount === 1) return analysisResponse();
      // code-gen returns invalid output (missing required field)
      return {
        content: JSON.stringify({ no_files_changed: true }),
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      };
    });

    const engine = createEngine(provider);
    const result = await engine.run({ pipeline: 'group-test', input: 'Build feature' });

    expect(result.status).toBe('failed');
    // Only 2 stage runs: analysis + code-gen (failed, no qa)
    expect(result.stages).toHaveLength(2);
  });

  it('preserves pre-group outputs across iterations', async () => {
    // Track what context the code-gen agent receives on iteration 2
    let callCount = 0;
    const callArgs: any[] = [];
    const provider = createMockProvider((...args: any[]) => {
      callCount++;
      callArgs.push(args);
      if (callCount === 1) return analysisResponse();
      if (callCount === 2) return codeGenResponse();
      if (callCount === 3) return qaRejectResponse('Bug', ['Fix it']);
      if (callCount === 4) return codeGenResponse();  // iter 2 code-gen
      return qaApproveResponse();
    });

    const engine = createEngine(provider);
    await engine.run({ pipeline: 'group-test', input: 'Build feature' });

    // The 4th call is code-gen iteration 2 — it should have analysis output in context
    // (Verified via provider.call args which include messages containing the context)
    expect(provider.call).toHaveBeenCalledTimes(5);
  });

  it('emits group lifecycle events', async () => {
    let callCount = 0;
    const provider = createMockProvider(() => {
      callCount++;
      if (callCount === 1) return analysisResponse();
      if (callCount === 2) return codeGenResponse();
      if (callCount === 3) return qaRejectResponse('Bug', ['Fix it']);
      if (callCount === 4) return codeGenResponse();
      return qaApproveResponse();
    });

    const events: string[] = [];
    const engineEvents: EngineEvents = {
      onGroupStart: () => events.push('group_start'),
      onGroupIteration: (e) => events.push(`group_iter_${e.iteration}`),
      onGroupFeedback: () => events.push('group_feedback'),
      onGroupComplete: (e) => events.push(`group_complete_${e.status}`),
      onStageStart: () => {},
      onStageComplete: () => {},
      onPipelineStart: () => {},
      onPipelineComplete: () => {},
    };

    const engine = createEngine(provider, engineEvents);
    await engine.run({ pipeline: 'group-test', input: 'Build feature' });

    expect(events).toContain('group_start');
    expect(events).toContain('group_iter_1');
    expect(events).toContain('group_feedback');
    expect(events).toContain('group_iter_2');
    expect(events).toContain('group_complete_success');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd engine && npx vitest run tests/group-loop.test.ts`
Expected: FAIL — `run()` doesn't handle group entries, tries to access `.name` / `.kind` on a `StageGroup`

**Step 3: Implement runGroup and update run()**

In `engine/src/engine.ts`, add the necessary imports at the top:

```typescript
import type {
  StageDefinition,
  PipelineEntry,
  StageGroup,
  // ... existing imports ...
} from '@studio/contracts';
import { isStageGroup } from '@studio/contracts';
import {
  createInitialContext,
  addStageOutput,
  getContextForStage,
  setGroupFeedback,
  clearGroupFeedback,
  type PipelineContext,
} from './pipeline/context-propagation.js';
```

Add the `countTotalStages` helper function (outside the class):

```typescript
function countTotalStages(entries: PipelineEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (isStageGroup(entry)) {
      count += entry.stages.length;
    } else {
      count++;
    }
  }
  return count;
}
```

Add `GroupResult` interface (inside engine.ts, near the other interfaces):

```typescript
interface GroupResult {
  status: string;
  stageRuns: StageRun[];
  stagesExecuted: number;
  context: PipelineContext;
}
```

Replace the stage loop in `run()` (lines 161-201) with:

```typescript
    const totalStages = countTotalStages(pipeline.stages);
    let stageCounter = 0;
    let previousStageName: string | undefined;

    for (const entry of pipeline.stages) {
      if (isStageGroup(entry)) {
        // ========== GROUP ==========
        const groupResult = await this.runGroup(
          entry,
          pipelineContext,
          stageCounter,
          totalStages,
          input.input,
        );

        pipelineRun.stages.push(...groupResult.stageRuns);
        stageCounter += groupResult.stagesExecuted;
        // Update previousStageName to the last stage in the group
        if (entry.stages.length > 0) {
          previousStageName = entry.stages[entry.stages.length - 1].name;
        }

        // Clear group feedback after group completes
        clearGroupFeedback(pipelineContext);

        if (groupResult.status === 'rejected' || groupResult.status === 'failed') {
          pipelineRun.status = groupResult.status as any;
          pipelineRun.completed_at = new Date().toISOString();
          this.events?.onPipelineComplete?.({
            pipeline_name: pipeline.name,
            run_id: pipelineRun.id,
            status: pipelineRun.status,
            duration_ms: Date.now() - pipelineStartTime,
            total_tokens: this.pipelineTotals.tokens,
            total_tool_calls: this.pipelineTotals.toolCalls,
          });
          this.emitter.emit({ type: 'pipeline_complete', pipelineId: pipelineRun.id });
          this.config.db?.savePipelineRun(pipelineRun);
          return pipelineRun;
        }
      } else {
        // ========== SIMPLE STAGE ==========
        stageCounter++;
        const result = await this.executeStage(
          entry,
          pipelineContext,
          previousStageName,
          input.input,
          stageCounter - 1,
          totalStages,
        );

        pipelineRun.stages.push(result.stageRun);

        if (result.status === 'failed' || result.status === 'rejected') {
          pipelineRun.status = result.stageRun.status;
          pipelineRun.completed_at = new Date().toISOString();
          this.events?.onPipelineComplete?.({
            pipeline_name: pipeline.name,
            run_id: pipelineRun.id,
            status: pipelineRun.status,
            duration_ms: Date.now() - pipelineStartTime,
            total_tokens: this.pipelineTotals.tokens,
            total_tool_calls: this.pipelineTotals.toolCalls,
          });
          this.emitter.emit({ type: 'pipeline_complete', pipelineId: pipelineRun.id });
          this.config.db?.savePipelineRun(pipelineRun);
          return pipelineRun;
        }

        if (result.lastAgentOutput !== undefined) {
          addStageOutput(pipelineContext, entry.name, result.lastAgentOutput);
        }

        previousStageName = entry.name;
      }
    }
```

Add the `runGroup` private method to the `PipelineEngine` class:

```typescript
  private async runGroup(
    group: StageGroup,
    context: PipelineContext,
    stageOffset: number,
    totalStages: number,
    userInput: string | Record<string, unknown>,
  ): Promise<GroupResult> {
    const allStageRuns: StageRun[] = [];
    let iteration = 0;

    this.events?.onGroupStart?.({
      group_name: group.group,
      max_iterations: group.max_iterations,
    });
    this.emitter.emit({
      type: 'group_start',
      groupName: group.group,
      maxIterations: group.max_iterations,
    });

    while (iteration < group.max_iterations) {
      iteration++;

      this.events?.onGroupIteration?.({
        group_name: group.group,
        iteration,
        max_iterations: group.max_iterations,
      });
      this.emitter.emit({
        type: 'group_iteration',
        groupName: group.group,
        iteration,
        maxIterations: group.max_iterations,
      });

      let groupSucceeded = true;
      let previousStageName: string | undefined;
      // Find the last stage name before this group in the pipeline context
      for (const [name] of context.stageOutputs) {
        previousStageName = name;
      }

      for (let i = 0; i < group.stages.length; i++) {
        const stage = group.stages[i];
        const stageNumber = stageOffset + i;

        const result = await this.executeStage(
          stage,
          context,
          previousStageName,
          userInput,
          stageNumber,
          totalStages,
        );

        allStageRuns.push(result.stageRun);

        // Technical failure → stop everything
        if (result.status === 'failed') {
          this.events?.onGroupComplete?.({
            group_name: group.group,
            iterations: iteration,
            status: 'failed',
          });
          this.emitter.emit({
            type: 'group_complete',
            groupName: group.group,
            iterations: iteration,
            status: 'failed',
          });
          return {
            status: 'failed',
            stageRuns: allStageRuns,
            stagesExecuted: group.stages.length,
            context,
          };
        }

        // Propagate output to context (will be cleared if we loop)
        if (result.lastAgentOutput !== undefined) {
          addStageOutput(context, stage.name, result.lastAgentOutput);
        }
        previousStageName = stage.name;

        // Last stage rejected → feedback loop
        const isLastStage = i === group.stages.length - 1;
        if (result.status === 'rejected' && isLastStage) {
          groupSucceeded = false;

          if (iteration < group.max_iterations) {
            // Clear group stage outputs for next iteration
            for (const gs of group.stages) {
              context.stageOutputs.delete(gs.name);
            }

            // Set feedback for next iteration
            setGroupFeedback(context, {
              iteration,
              max_iterations: group.max_iterations,
              rejection_reason: result.postValidation?.rejection_reason || 'Rejected by QA',
              rejection_details: result.postValidation?.rejection_details,
            });

            this.events?.onGroupFeedback?.({
              group_name: group.group,
              iteration,
              rejection_reason: result.postValidation?.rejection_reason || 'Rejected by QA',
              rejection_details: result.postValidation?.rejection_details || [],
            });
            this.emitter.emit({
              type: 'group_feedback',
              groupName: group.group,
              iteration,
              rejectionReason: result.postValidation?.rejection_reason || 'Rejected by QA',
            });
          }

          break; // Exit inner stage loop, retry group
        }

        // Non-gate stage rejected → stop
        if (result.status === 'rejected') {
          this.events?.onGroupComplete?.({
            group_name: group.group,
            iterations: iteration,
            status: 'rejected',
          });
          this.emitter.emit({
            type: 'group_complete',
            groupName: group.group,
            iterations: iteration,
            status: 'rejected',
          });
          return {
            status: 'rejected',
            stageRuns: allStageRuns,
            stagesExecuted: group.stages.length,
            context,
          };
        }
      }

      if (groupSucceeded) {
        this.events?.onGroupComplete?.({
          group_name: group.group,
          iterations: iteration,
          status: 'success',
        });
        this.emitter.emit({
          type: 'group_complete',
          groupName: group.group,
          iterations: iteration,
          status: 'success',
        });
        return {
          status: 'success',
          stageRuns: allStageRuns,
          stagesExecuted: group.stages.length,
          context,
        };
      }
    }

    // Max iterations exhausted
    this.events?.onGroupComplete?.({
      group_name: group.group,
      iterations: iteration,
      status: 'rejected',
    });
    this.emitter.emit({
      type: 'group_complete',
      groupName: group.group,
      iterations: iteration,
      status: 'rejected',
    });
    return {
      status: 'rejected',
      stageRuns: allStageRuns,
      stagesExecuted: group.stages.length,
      context,
    };
  }
```

**Step 4: Run group tests to verify they pass**

Run: `cd engine && npx vitest run tests/group-loop.test.ts`
Expected: All 6 tests PASS

**Step 5: Run ALL engine tests to verify no regressions**

Run: `cd engine && npx vitest run`
Expected: All tests PASS (engine.test.ts, loader.test.ts, context-propagation.test.ts, group-loop.test.ts, etc.)

**Step 6: Commit**

```bash
git add engine/src/engine.ts engine/tests/group-loop.test.ts
git commit -m "feat(engine): implement feedback loop groups with runGroup()"
```

---

### Task 7: Update feature-builder pipeline YAML

**Files:**
- Modify: `engine/pipelines/feature-builder.pipeline.yaml`
- Modify: `engine/tests/loader.test.ts` (update real-file test expectation)

**Step 1: Update the pipeline YAML**

Replace the pipeline to wrap code-generation + qa-review in a group:

```yaml
name: feature-builder
description: Build a feature from a user description
version: 2

repo:
  url: https://github.com/arianeguay/pipelines-test-repo
  branch: main

stages:
  - name: brief-analysis
    kind: analysis
    agent: analyst
    contract: brief-analysis
    ralph:
      max_attempts: 3
      retry_strategy: exponential
    context:
      include:
        - input

  - name: implementation-plan
    kind: planning
    agent: analyst
    contract: implementation-plan
    ralph:
      max_attempts: 3
      retry_strategy: exponential
    context:
      include:
        - input
        - previous_stage_output

  - group: implementation-review
    max_iterations: 3
    stages:
      - name: code-generation
        kind: code_generation
        agent: coder
        contract: code-generation
        ralph:
          max_attempts: 5
          retry_strategy: exponential
        tools:
          required:
            - repo_manager-write_file
        context:
          include:
            - input
            - all_stage_outputs
            - repo_files
            - group_feedback

      - name: qa-review
        kind: qa
        agent: analyst
        contract: qa-review
        ralph:
          max_attempts: 3
          retry_strategy: exponential
        context:
          include:
            - input
            - all_stage_outputs
```

**Step 2: Update the loader test for real files**

In `engine/tests/loader.test.ts`, update the test at line 113-115:

```typescript
  it('loads feature-builder.pipeline.yaml', async () => {
    const pipeline = await loadPipeline(join(PIPELINES_DIR, 'feature-builder.pipeline.yaml'));
    expect(pipeline.name).toBe('feature-builder');
    // 2 simple stages + 1 group = 3 entries
    expect(pipeline.stages).toHaveLength(3);
  });
```

**Step 3: Run loader tests**

Run: `cd engine && npx vitest run tests/loader.test.ts`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add engine/pipelines/feature-builder.pipeline.yaml engine/tests/loader.test.ts
git commit -m "feat(pipeline): wrap code-gen + qa in feedback loop group"
```

---

### Task 8: Add group events to CLI progress display

**Files:**
- Modify: `cli/src/output/progress.ts`

**Step 1: Update ProgressDisplay to handle group events**

In `cli/src/output/progress.ts`, add group event handlers to the `getEvents()` return object, after `onTaskRetry`:

```typescript
      onGroupStart: () => {
        // Silent — group is transparent at the pipeline level
      },

      onGroupIteration: (event) => {
        if (this.jsonMode) return;
        if (event.iteration > 1) {
          console.log(chalk.yellow(`\n  ↻ Feedback loop iteration ${event.iteration}/${event.max_iterations}`));
        }
      },

      onGroupFeedback: (event) => {
        if (this.jsonMode) return;
        console.log(chalk.yellow(`    QA rejected: ${event.rejection_reason}`));
        if (this.verbose && event.rejection_details.length > 0) {
          for (const detail of event.rejection_details) {
            console.log(chalk.yellow(`      - ${detail}`));
          }
        }
        console.log(chalk.yellow(`    Re-running code generation with feedback...`));
      },

      onGroupComplete: (event) => {
        if (this.jsonMode) return;
        if (event.iterations > 1) {
          if (event.status === 'success') {
            console.log(chalk.green(`    ✓ Approved after ${event.iterations} iterations`));
          } else {
            console.log(chalk.red(`    ✗ Rejected after ${event.iterations} iterations (max reached)`));
          }
        }
      },
```

**Step 2: Build CLI to verify**

Run: `cd cli && npm run build`
Expected: Clean compilation

**Step 3: Commit**

```bash
git add cli/src/output/progress.ts
git commit -m "feat(cli): display feedback loop group events in progress output"
```

---

### Task 9: Full build + all tests

**Step 1: Full monorepo build**

Run:
```bash
cd contracts && npm run build && cd .. && \
cd ralph && npm run build && cd .. && \
cd runner && npm run build && cd .. && \
cd engine && npm run build && cd .. && \
cd cli && npm run build && cd ..
```
Expected: All packages build successfully

**Step 2: Run all engine tests**

Run: `cd engine && npx vitest run`
Expected: All tests pass

**Step 3: Final commit (if any build fixes needed)**

If everything passes clean, no commit needed.
