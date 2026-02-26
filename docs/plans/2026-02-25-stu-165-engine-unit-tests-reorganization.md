# STU-165 Engine Unit Tests Reorganization — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move existing engine tests into a `tests/unit/` subdirectory as specified in STU-165, and add the one missing integration test for `on_pipeline_start` context injection.

**Architecture:** Three existing test files (`status-derivation.test.ts`, `engine.test.ts`, `group-loop.test.ts`) are moved into `engine/tests/unit/` with import paths updated to reflect the deeper nesting. The `on_pipeline_start` integration test is added to `unit/engine.test.ts` since it was the only coverage gap identified in the issue. The old flat files are deleted after the new ones are verified.

**Tech Stack:** TypeScript, Vitest, Node.js. All imports use `.js` extensions (ESM).

---

### Task 1: Create `engine/tests/unit/state/status-derivation.test.ts`

**Files:**
- Create: `engine/tests/unit/state/status-derivation.test.ts`
- Delete after verification: `engine/tests/status-derivation.test.ts`

This is a pure move. The only change is the import path: from `../src/state/status-derivation.js` to `../../../src/state/status-derivation.js` (the file is now 3 levels deep from the engine root instead of 2).

**Step 1: Create the file**

Create `engine/tests/unit/state/status-derivation.test.ts`:

```typescript
// THIS IS THE CRITICAL TEST
// Status derivation was the #1 bug in v6
// Write this test FIRST, then implement the function

import { describe, it, expect } from 'vitest';
import { deriveStageStatus } from '../../../src/state/status-derivation.js';
import type { RalphResult } from '@studio/ralph';
import type { StageStatus } from '@studio/contracts';

describe('deriveStageStatus', () => {
  it('ralph success → stage success', () => {
    const ralphResult: RalphResult<unknown> = {
      status: 'success',
      result: { output: 'some result' },
      attempts: 1
    };

    const stageStatus: StageStatus = deriveStageStatus(ralphResult);
    expect(stageStatus).toBe('success');
  });

  it('ralph exhausted → stage failed', () => {
    const ralphResult: RalphResult<unknown> = {
      status: 'exhausted',
      lastResult: { output: 'failed result' },
      failures: ['Validation failed', 'Tool call missing'],
      attempts: 3
    };

    const stageStatus: StageStatus = deriveStageStatus(ralphResult);
    expect(stageStatus).toBe('failed');
  });

  it('success after multiple attempts → stage success', () => {
    const ralphResult: RalphResult<unknown> = {
      status: 'success',
      result: { output: 'finally worked' },
      attempts: 4
    };

    const stageStatus: StageStatus = deriveStageStatus(ralphResult);
    expect(stageStatus).toBe('success');
  });

  it('success after 1 attempt → stage success', () => {
    const ralphResult: RalphResult<unknown> = {
      status: 'success',
      result: null,
      attempts: 1
    };

    const stageStatus: StageStatus = deriveStageStatus(ralphResult);
    expect(stageStatus).toBe('success');
  });

  it('exhausted after max attempts → stage failed', () => {
    const ralphResult: RalphResult<unknown> = {
      status: 'exhausted',
      lastResult: {},
      failures: ['Error 1', 'Error 2', 'Error 3'],
      attempts: 5
    };

    const stageStatus: StageStatus = deriveStageStatus(ralphResult);
    expect(stageStatus).toBe('failed');
  });

  it('ralph cancelled → stage cancelled', () => {
    const ralphResult = {
      status: 'cancelled' as const,
      lastResult: undefined,
      attempts: 2,
    };

    const stageStatus = deriveStageStatus(ralphResult as any);
    expect(stageStatus).toBe('cancelled');
  });

  it('throws error for invalid ralph status', () => {
    const invalidResult = {
      status: 'invalid_status' as any,
      result: {},
      attempts: 1
    };

    expect(() => deriveStageStatus(invalidResult as any)).toThrow('Unknown ralph status');
  });
});
```

**Step 2: Run only this file to verify all 7 tests pass**

```bash
pnpm --filter @studio/engine exec vitest run tests/unit/state/status-derivation.test.ts
```

Expected: 7 tests pass.

**Step 3: Delete the old flat file**

```bash
rm engine/tests/status-derivation.test.ts
```

**Step 4: Run the full engine test suite**

```bash
pnpm --filter @studio/engine test
```

Expected: All tests pass (same count as before minus the 7 now-deleted flat tests, plus the 7 new unit tests — net same total).

**Step 5: Commit**

```bash
git add engine/tests/unit/state/status-derivation.test.ts engine/tests/status-derivation.test.ts
git commit -m "test(engine): move status-derivation tests to tests/unit/state/ (STU-165)"
```

---

### Task 2: Create `engine/tests/unit/group-loop.test.ts`

**Files:**
- Create: `engine/tests/unit/group-loop.test.ts`
- Delete after verification: `engine/tests/group-loop.test.ts`

Pure move. Import paths change:
- `../src/engine.js` → `../../src/engine.js`
- `../src/state/run-store.js` → `../../src/state/run-store.js`
- `../src/events.js` → `../../src/events.js`

Fixtures dir: `join(import.meta.dirname, 'fixtures')` → `join(import.meta.dirname, '..', 'fixtures')` (so it still resolves to `engine/tests/fixtures/`).

**Step 1: Create the file**

Create `engine/tests/unit/group-loop.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { PipelineEngine, type EngineConfig } from '../../src/engine.js';
import { InMemoryRunStore } from '../../src/state/run-store.js';
import type { EngineEvents } from '../../src/events.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');
const PROJECT_DIR = join(FIXTURES_DIR, 'test-project');
const PIPELINES_DIR = join(PROJECT_DIR, 'pipelines');
const AGENTS_DIR = join(PROJECT_DIR, 'agents');
const CONTRACTS_DIR = join(PROJECT_DIR, 'contracts');

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
post_validation:
  rejection_detection:
    field: status
    approved_values:
      - approved
      - pass
    details_field: issues
    summary_field: summary
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
    getActiveSnippets: vi.fn().mockReturnValue([]),
  };
}

function createEngine(provider: any, events?: EngineEvents): PipelineEngine {
  return new PipelineEngine(
    {
      configsDir: PROJECT_DIR,
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

  it('passes object issues from QA rejection into group_feedback for the coder', async () => {
    // Regression test for STU-129: group_feedback.rejection_details was empty when
    // QA returned issues as objects with field names other than "description".
    let callCount = 0;
    let coderIter2Messages: any[] = [];
    const provider = createMockProvider((...args: any[]) => {
      callCount++;
      if (callCount === 1) return analysisResponse();
      if (callCount === 2) return codeGenResponse();   // iter 1
      if (callCount === 3) {
        // QA rejects with structured issues (objects with "issue" field, not "description")
        return {
          content: JSON.stringify({
            status: 'needs_changes',
            summary: 'Several problems found',
            issues: [
              { issue: 'Missing error handling', severity: 'high' },
              { issue: 'No input validation', file: 'src/api.ts' },
            ],
          }),
          tool_calls: [],
          finish_reason: 'stop',
          usage: { prompt_tokens: 150, completion_tokens: 50, total_tokens: 200 },
        };
      }
      if (callCount === 4) {
        // Capture the messages sent to the coder on iteration 2
        coderIter2Messages = args[0]?.messages ?? [];
        return codeGenResponse();
      }
      return qaApproveResponse();
    });

    const engine = createEngine(provider);
    const result = await engine.run({ pipeline: 'group-test', input: 'Build feature' });

    expect(result.status).toBe('success');
    expect(provider.call).toHaveBeenCalledTimes(5);

    // The coder on iteration 2 must have received group_feedback with the specific issues
    const userMessage = coderIter2Messages.find((m: any) => m.role === 'user');
    expect(userMessage).toBeDefined();
    expect(userMessage.content).toContain('REVISION REQUIRED');
    expect(userMessage.content).toContain('Missing error handling');
    expect(userMessage.content).toContain('No input validation');
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

**Step 2: Run only this file to verify all 7 tests pass**

```bash
pnpm --filter @studio/engine exec vitest run tests/unit/group-loop.test.ts
```

Expected: 7 tests pass.

**Step 3: Delete the old flat file**

```bash
rm engine/tests/group-loop.test.ts
```

**Step 4: Run the full suite**

```bash
pnpm --filter @studio/engine test
```

Expected: All tests pass.

**Step 5: Commit**

```bash
git add engine/tests/unit/group-loop.test.ts engine/tests/group-loop.test.ts
git commit -m "test(engine): move group-loop tests to tests/unit/ (STU-165)"
```

---

### Task 3: Create `engine/tests/unit/engine.test.ts` with `on_pipeline_start` test

**Files:**
- Create: `engine/tests/unit/engine.test.ts`
- Delete after verification: `engine/tests/engine.test.ts`

Import path changes (same pattern as group-loop):
- `../src/engine.js` → `../../src/engine.js`
- `../src/state/run-store.js` → `../../src/state/run-store.js`
- `../src/events.js` → `../../src/events.js`

Fixtures dir: `join(import.meta.dirname, '..', 'fixtures')`.

**New test added:** `on_pipeline_start output is injected into stage context`
- A new fixture pipeline `with-startup` is written inside `setupTestFixtures()`
- The pipeline has `on_pipeline_start: [{command: "echo git-status-output", inject_as: git_status}]`
- The stage includes `pipeline_start_context` in `context.include`
- The test captures what the mock provider receives and asserts `git-status-output` is in the user message
  (the prompt-builder formats startup_context as `### git_status\n\`\`\`\ngit-status-output\n\`\`\``)

**Step 1: Create the file**

Create `engine/tests/unit/engine.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { PipelineEngine, type EngineConfig, type RunInput } from '../../src/engine.js';
import { InMemoryRunStore } from '../../src/state/run-store.js';
import type { EngineEvents } from '../../src/events.js';

// Minimal mock for ProviderRegistry
function createMockProviderRegistry() {
  const mockProvider = {
    name: 'anthropic',
    call: vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'Test summary',
        requirements: ['req1'],
        acceptance_criteria: ['ac1'],
        steps: ['step1'],
        files_to_modify: ['file.ts'],
        risks: ['none'],
        files_changed: ['file.ts'],
        status: 'pass',
        issues: [],
      }),
      tool_calls: [],
      finish_reason: 'stop',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
  };

  return {
    get: vi.fn().mockReturnValue(mockProvider),
    register: vi.fn(),
  };
}

// Minimal mock for ToolRegistry
function createMockToolRegistry() {
  return {
    register: vi.fn(),
    get: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    list: vi.fn().mockReturnValue([]),
    toToolDefinitions: vi.fn().mockReturnValue([]),
    filter: vi.fn().mockReturnThis(),
    getActiveSnippets: vi.fn().mockReturnValue([]),
  };
}

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');
const PROJECT_DIR = join(FIXTURES_DIR, 'test-project');
const PIPELINES_DIR = join(PROJECT_DIR, 'pipelines');
const AGENTS_DIR = join(PROJECT_DIR, 'agents');
const CONTRACTS_DIR = join(PROJECT_DIR, 'contracts');

// Create minimal test fixtures
import { mkdirSync, writeFileSync } from 'node:fs';

function setupTestFixtures() {
  mkdirSync(PIPELINES_DIR, { recursive: true });
  mkdirSync(AGENTS_DIR, { recursive: true });
  mkdirSync(CONTRACTS_DIR, { recursive: true });

  writeFileSync(join(PIPELINES_DIR, 'simple.pipeline.yaml'), `
name: simple
description: Simple test pipeline
version: 1
stages:
  - name: analysis
    kind: analysis
    agent: test-agent
    contract: test-contract
    ralph:
      max_attempts: 2
      retry_strategy: none
    context:
      include:
        - input
`);

  writeFileSync(join(PIPELINES_DIR, 'two-stage.pipeline.yaml'), `
name: two-stage
description: Two stage pipeline
version: 1
stages:
  - name: stage-1
    kind: analysis
    agent: test-agent
    ralph:
      max_attempts: 1
      retry_strategy: none
    context:
      include:
        - input
  - name: stage-2
    kind: planning
    agent: test-agent
    ralph:
      max_attempts: 1
      retry_strategy: none
    context:
      include:
        - input
        - previous_stage_output
`);

  writeFileSync(join(AGENTS_DIR, 'test-agent.agent.yaml'), `
name: test-agent
provider: anthropic
model: claude-sonnet-4-20250514
temperature: 0.3
`);

  writeFileSync(join(CONTRACTS_DIR, 'test-contract.contract.yaml'), `
name: test-contract
version: 1
schema:
  required_fields:
    - summary
`);
  writeFileSync(join(PIPELINES_DIR, 'hook-output-template.pipeline.yaml'), `
name: hook-output-template
description: Pipeline that verifies on_stage_complete hook receives stage output as template context
version: 1
stages:
  - name: analysis
    kind: analysis
    agent: test-agent
    contract: test-contract
    hooks:
      on_stage_complete:
        - command: "sh -c 'echo {{output.files_changed}} | grep -qx file.ts'"
          on_failure: reject
    ralph:
      max_attempts: 1
      retry_strategy: none
    context:
      include:
        - input
`);
  writeFileSync(join(PIPELINES_DIR, 'hook-reject-on-failure.pipeline.yaml'), `
name: hook-reject-on-failure
description: Pipeline where on_stage_complete hook fails and rejects the stage
version: 1
stages:
  - name: analysis
    kind: analysis
    agent: test-agent
    contract: test-contract
    hooks:
      on_stage_complete:
        - command: "sh -c 'echo hook-error-output >&2; exit 1'"
          on_failure: reject
    ralph:
      max_attempts: 1
      retry_strategy: none
    context:
      include:
        - input
`);

  // Fixture for on_pipeline_start integration test
  writeFileSync(join(PIPELINES_DIR, 'with-startup.pipeline.yaml'), `
name: with-startup
description: Pipeline that exercises on_pipeline_start context injection
version: 1
on_pipeline_start:
  - command: "echo git-status-output"
    inject_as: git_status
stages:
  - name: analysis
    kind: analysis
    agent: test-agent
    contract: test-contract
    ralph:
      max_attempts: 1
      retry_strategy: none
    context:
      include:
        - input
        - pipeline_start_context
`);
}

// Setup fixtures before all tests
setupTestFixtures();

function createTestEngine(overrides: Partial<EngineConfig> = {}): PipelineEngine {
  return new PipelineEngine({
    configsDir: PROJECT_DIR,
    providerRegistry: createMockProviderRegistry() as any,
    toolRegistry: createMockToolRegistry() as any,
    db: new InMemoryRunStore(),
    ...overrides,
  });
}

describe('PipelineEngine', () => {
  it('runs a simple single-stage pipeline', async () => {
    const engine = createTestEngine();
    const result = await engine.run({
      pipeline: 'simple',
      input: 'Add a FAQ section',
    });

    expect(result.status).toBe('success');
    expect(result.pipeline_name).toBe('simple');
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].stage_name).toBe('analysis');
    expect(result.stages[0].status).toBe('success');
  });

  it('runs a multi-stage pipeline', async () => {
    const engine = createTestEngine();
    const result = await engine.run({
      pipeline: 'two-stage',
      input: 'Build feature X',
    });

    expect(result.status).toBe('success');
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0].stage_name).toBe('stage-1');
    expect(result.stages[1].stage_name).toBe('stage-2');
  });

  it('persists run to store', async () => {
    const store = new InMemoryRunStore();
    const engine = createTestEngine({ db: store });

    const result = await engine.run({
      pipeline: 'simple',
      input: 'Test persist',
    });

    const stored = store.getPipelineRun(result.id);
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe(result.id);
    expect(stored!.status).toBe('success');
  });

  it('emits lifecycle events', async () => {
    const events: string[] = [];
    const engineEvents: EngineEvents = {
      onPipelineStart: () => events.push('pipeline_start'),
      onPipelineComplete: () => events.push('pipeline_complete'),
      onStageStart: () => events.push('stage_start'),
      onStageComplete: () => events.push('stage_complete'),
    };

    const engine = new PipelineEngine(
      {
        configsDir: PROJECT_DIR,
        providerRegistry: createMockProviderRegistry() as any,
        toolRegistry: createMockToolRegistry() as any,
      },
      engineEvents
    );

    await engine.run({ pipeline: 'simple', input: 'test events' });

    expect(events).toEqual([
      'pipeline_start',
      'stage_start',
      'stage_complete',
      'pipeline_complete',
    ]);
  });

  it('stops pipeline on stage failure (validation fails)', async () => {
    // Provider returns output missing required 'summary' field
    const badProvider = {
      name: 'anthropic',
      call: vi.fn().mockResolvedValue({
        content: JSON.stringify({ no_summary: true }),
        tool_calls: [],
        finish_reason: 'stop',
      }),
    };

    const engine = createTestEngine({
      providerRegistry: { get: vi.fn().mockReturnValue(badProvider), register: vi.fn() } as any,
    });

    const result = await engine.run({
      pipeline: 'simple',
      input: 'This should fail validation',
    });

    expect(result.status).toBe('failed');
    expect(result.stages[0].status).toBe('failed');
  });

  it('sets completed_at on pipeline run', async () => {
    const engine = createTestEngine();
    const result = await engine.run({
      pipeline: 'simple',
      input: 'test timestamps',
    });

    expect(result.started_at).toBeDefined();
    expect(result.completed_at).toBeDefined();
  });

  it('creates proper stage run with tasks and agent runs', async () => {
    const engine = createTestEngine();
    const result = await engine.run({
      pipeline: 'simple',
      input: 'test structure',
    });

    const stage = result.stages[0];
    expect(stage.tasks).toHaveLength(1);

    const task = stage.tasks[0];
    expect(task.task_name).toBe('analysis');
    expect(task.agent_runs.length).toBeGreaterThanOrEqual(1);

    const agentRun = task.agent_runs[0];
    expect(agentRun.agent_name).toBe('test-agent');
    expect(agentRun.attempt).toBe(1);
  });

  it('throws for non-existent pipeline', async () => {
    const engine = createTestEngine();
    await expect(
      engine.run({ pipeline: 'nonexistent', input: 'test' })
    ).rejects.toThrow('Failed to load pipeline');
  });

  it('emits enriched stage complete events with summary and tokens', async () => {
    const stageEvents: any[] = [];
    const engineEvents: EngineEvents = {
      onPipelineStart: () => {},
      onPipelineComplete: () => {},
      onStageStart: () => {},
      onStageComplete: (e) => stageEvents.push(e),
    };

    const engine = new PipelineEngine(
      {
        configsDir: PROJECT_DIR,
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
        configsDir: PROJECT_DIR,
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

  it('emits pipeline_complete with status failed when stage fails', async () => {
    const pipelineEvents: any[] = [];
    const badProvider = {
      name: 'anthropic',
      call: vi.fn().mockResolvedValue({
        content: JSON.stringify({ no_summary: true }),
        tool_calls: [],
        finish_reason: 'stop',
      }),
    };

    const engine = new PipelineEngine(
      {
        configsDir: PROJECT_DIR,
        providerRegistry: { get: vi.fn().mockReturnValue(badProvider), register: vi.fn() } as any,
        toolRegistry: createMockToolRegistry() as any,
      },
      { onPipelineComplete: (e) => pipelineEvents.push(e) }
    );

    const result = await engine.run({ pipeline: 'simple', input: 'will fail' });

    expect(result.status).toBe('failed');
    expect(pipelineEvents).toHaveLength(1);
    expect(pipelineEvents[0].status).toBe('failed');
    expect(typeof pipelineEvents[0].duration_ms).toBe('number');
    expect(typeof pipelineEvents[0].total_tokens).toBe('number');
    expect(typeof pipelineEvents[0].total_tool_calls).toBe('number');
  });

  it('emits pipeline_complete with status rejected when stage is rejected', async () => {
    const pipelineEvents: any[] = [];

    const engine = new PipelineEngine(
      {
        configsDir: PROJECT_DIR,
        providerRegistry: createMockProviderRegistry() as any,
        toolRegistry: createMockToolRegistry() as any,
      },
      { onPipelineComplete: (e) => pipelineEvents.push(e) }
    );

    const result = await engine.run({ pipeline: 'hook-reject-on-failure', input: 'will reject' });

    expect(result.status).toBe('rejected');
    expect(pipelineEvents).toHaveLength(1);
    expect(pipelineEvents[0].status).toBe('rejected');
    expect(typeof pipelineEvents[0].duration_ms).toBe('number');
  });

  it('on_stage_complete hook receives stage output as template context', async () => {
    const engine = createTestEngine();
    const result = await engine.run({
      pipeline: 'hook-output-template',
      input: 'test',
    });

    // The hook checks {{output.files_changed}} == 'file.ts'
    // The mock provider returns files_changed: ['file.ts'] → renders as 'file.ts'
    // Without the fix: template not resolved → hook fails → stage rejected
    // With the fix: template resolves correctly → hook passes → stage succeeds
    expect(result.status).toBe('success');
    expect(result.stages[0].status).toBe('success');
  });

  it('on_stage_complete hook failure with on_failure:reject causes stage rejection', async () => {
    const engine = createTestEngine();
    const result = await engine.run({
      pipeline: 'hook-reject-on-failure',
      input: 'test',
    });

    expect(result.status).toBe('rejected');
    expect(result.stages[0].status).toBe('rejected');
    expect(result.stages[0]).toMatchObject({
      status: 'rejected',
    });
  });

  it('returns cancelled when signal is aborted before stages run', async () => {
    const controller = new AbortController();
    controller.abort(); // Pre-aborted

    const engine = createTestEngine();
    const result = await engine.run({
      pipeline: 'simple',
      input: 'test input',
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(result.stages).toHaveLength(0);
  });

  it('on_pipeline_start output is injected into stage context', async () => {
    // The 'with-startup' pipeline runs `echo git-status-output` and injects it
    // as 'git_status'. The stage includes 'pipeline_start_context'.
    // The prompt-builder formats startup_context as:
    //   ## Pipeline Startup Context
    //   ### git_status
    //   ```
    //   git-status-output
    //   ```
    // So we assert that the provider received a user message containing that value.
    const capturedRequests: any[] = [];
    const provider = {
      name: 'anthropic',
      call: vi.fn().mockImplementation(async (req: any) => {
        capturedRequests.push(req);
        return {
          content: JSON.stringify({ summary: 'done', requirements: [], acceptance_criteria: [] }),
          tool_calls: [],
          finish_reason: 'stop',
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        };
      }),
    };

    const engine = createTestEngine({
      providerRegistry: { get: vi.fn().mockReturnValue(provider), register: vi.fn() } as any,
    });

    const result = await engine.run({ pipeline: 'with-startup', input: 'test startup' });

    expect(result.status).toBe('success');
    expect(capturedRequests).toHaveLength(1);

    const userMessage = capturedRequests[0].messages.find((m: any) => m.role === 'user');
    expect(userMessage).toBeDefined();
    expect(userMessage.content).toContain('git-status-output');
  });
});
```

**Step 2: Run only this file to verify all 16 tests pass**

```bash
pnpm --filter @studio/engine exec vitest run tests/unit/engine.test.ts
```

Expected: 16 tests pass (15 existing + 1 new).

**Step 3: Delete the old flat file**

```bash
rm engine/tests/engine.test.ts
```

**Step 4: Run the full suite**

```bash
pnpm --filter @studio/engine test
```

Expected: All tests pass. Test count increases by 1 (the new `on_pipeline_start` test).

**Step 5: Commit**

```bash
git add engine/tests/unit/engine.test.ts engine/tests/engine.test.ts
git commit -m "test(engine): move engine tests to tests/unit/ + add on_pipeline_start integration test (STU-165)"
```

---

### Task 4: Final verification

**Step 1: Run the complete engine test suite one final time**

```bash
pnpm --filter @studio/engine test
```

Expected output:
```
✓ tests/unit/state/status-derivation.test.ts (7 tests)
✓ tests/unit/engine.test.ts (16 tests)
✓ tests/unit/group-loop.test.ts (7 tests)
... (all other test files unchanged)
Tests  222 passed | 1 skipped
```

**Step 2: Verify no orphaned flat test files remain**

```bash
ls engine/tests/*.test.ts 2>&1
```

Expected: No `.test.ts` files at the flat level (only `tests/unit/`, `tests/e2e/`, and the `src/` colocated tests).

**Step 3: Push and open PR**

```bash
git push -u origin arianedguay/stu-165-testengine-ajouter-tests-unitaires-pour-enginets-et-status
gh pr create --title "test(engine): reorganize tests into unit/ + add on_pipeline_start test (STU-165)" \
  --body "..."
```
