import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { PipelineEngine } from '../../src/engine.js';
import { InMemoryRunStore } from '../../src/state/run-store.js';
import type { EngineEvents } from '../../src/events.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');
const PROJECT_DIR = join(FIXTURES_DIR, 'test-project-group-parallel');
const PIPELINES_DIR = join(PROJECT_DIR, 'pipelines');
const AGENTS_DIR = join(PROJECT_DIR, 'agents');
const CONTRACTS_DIR = join(PROJECT_DIR, 'contracts');

mkdirSync(PIPELINES_DIR, { recursive: true });
mkdirSync(AGENTS_DIR, { recursive: true });
mkdirSync(CONTRACTS_DIR, { recursive: true });

// Agent fixture (this file owns its project dir)
writeFileSync(join(AGENTS_DIR, 'test-agent.agent.yaml'), `
name: test-agent
provider: anthropic
model: claude-sonnet-4-20250514
temperature: 0.3
`);

// Contract requiring 'result' field
writeFileSync(join(CONTRACTS_DIR, 'basic-result.contract.yaml'), `
name: basic-result
version: 1
schema:
  required_fields:
    - result
`);

// Contract with missing required fields to trigger failure
writeFileSync(join(CONTRACTS_DIR, 'strict-result.contract.yaml'), `
name: strict-result
version: 1
schema:
  required_fields:
    - result
    - must_exist
`);

// Pipeline: 3 stages in parallel, all use basic-result contract
writeFileSync(join(PIPELINES_DIR, 'parallel-test.pipeline.yaml'), `
name: parallel-test
description: Test pipeline with parallel group
version: 1
stages:
  - group: parallel-work
    mode: parallel
    max_iterations: 1
    stages:
      - name: stage-a
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
      - name: stage-b
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
      - name: stage-c
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
`);

// Pipeline: parallel group where stage-b uses strict-result (will fail if wrong output)
writeFileSync(join(PIPELINES_DIR, 'parallel-fail-test.pipeline.yaml'), `
name: parallel-fail-test
description: Test pipeline with a failing stage in parallel group
version: 1
stages:
  - group: parallel-work
    mode: parallel
    on_failure: fail-fast
    stages:
      - name: stage-a
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
      - name: stage-b
        kind: analysis
        agent: test-agent
        contract: strict-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
      - name: stage-c
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
`);

// Pipeline: parallel group with collect-all
writeFileSync(join(PIPELINES_DIR, 'parallel-collect-all-test.pipeline.yaml'), `
name: parallel-collect-all-test
description: Test pipeline with collect-all parallel group
version: 1
stages:
  - group: parallel-work
    mode: parallel
    on_failure: collect-all
    stages:
      - name: stage-a
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
      - name: stage-b
        kind: analysis
        agent: test-agent
        contract: strict-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
      - name: stage-c
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
`);

// Pipeline: parallel group followed by a sequential stage
writeFileSync(join(PIPELINES_DIR, 'parallel-then-sequential-test.pipeline.yaml'), `
name: parallel-then-sequential-test
description: Test pipeline with parallel group followed by sequential stage
version: 1
stages:
  - group: parallel-work
    mode: parallel
    stages:
      - name: stage-a
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
      - name: stage-b
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
  - name: merge-results
    kind: merge
    agent: test-agent
    contract: basic-result
    ralph:
      max_attempts: 1
      retry_strategy: none
    context:
      include:
        - all_stage_outputs
`);

function mockProvider(callFn: (...args: any[]) => any) {
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
    clone: vi.fn().mockReturnThis(),
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

function successResponse(extra: Record<string, unknown> = {}) {
  return {
    content: JSON.stringify({ result: 'ok', ...extra }),
    tool_calls: [],
    finish_reason: 'stop',
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

describe('Parallel group', () => {
  it('runs all stages concurrently and succeeds when all pass', async () => {
    const provider = mockProvider(() => successResponse());
    const engine = createEngine(provider);

    const result = await engine.run({ pipeline: 'parallel-test', input: 'Test' });

    expect(result.status).toBe('success');
    expect(result.stages).toHaveLength(3);
    expect(result.stages.map(s => s.stage_name)).toEqual(['stage-a', 'stage-b', 'stage-c']);
    expect(provider.call).toHaveBeenCalledTimes(3);
  });

  it('stage runs are ordered by definition order (not execution order)', async () => {
    const provider = mockProvider(() => successResponse());
    const engine = createEngine(provider);

    const result = await engine.run({ pipeline: 'parallel-test', input: 'Test' });

    expect(result.stages[0].stage_name).toBe('stage-a');
    expect(result.stages[1].stage_name).toBe('stage-b');
    expect(result.stages[2].stage_name).toBe('stage-c');
  });

  it('fails group when one stage fails (fail-fast)', async () => {
    // stage-b uses strict-result contract which requires 'must_exist' — mock only returns 'result'
    const provider = mockProvider(() => successResponse());
    const engine = createEngine(provider);

    const result = await engine.run({ pipeline: 'parallel-fail-test', input: 'Test' });

    expect(result.status).toBe('failed');
    // stage-b failed, overall group failed
    const stageBRun = result.stages.find(s => s.stage_name === 'stage-b');
    expect(stageBRun).toBeDefined();
    expect(stageBRun?.status).toBe('failed');
  });

  it('fails group when one stage fails (collect-all), all stages still run', async () => {
    // stage-b uses strict-result — will fail
    const provider = mockProvider(() => successResponse());
    const engine = createEngine(provider);

    const result = await engine.run({ pipeline: 'parallel-collect-all-test', input: 'Test' });

    expect(result.status).toBe('failed');
    // All 3 stages were executed (collect-all doesn't abort)
    expect(provider.call).toHaveBeenCalledTimes(3);
    // The 3 stage runs are all present
    expect(result.stages).toHaveLength(3);
  });

  it('merges successful stage outputs into context after group succeeds', async () => {
    let callCount = 0;
    const provider = mockProvider(() => {
      callCount++;
      return successResponse({ call_number: callCount });
    });
    const engine = createEngine(provider);

    // parallel-then-sequential-test: group (stage-a, stage-b) then merge-results stage
    // merge-results stage uses all_stage_outputs — it will receive stage-a and stage-b outputs
    const result = await engine.run({ pipeline: 'parallel-then-sequential-test', input: 'Test' });

    expect(result.status).toBe('success');
    // 3 calls total: stage-a, stage-b (parallel), then merge-results (sequential)
    expect(provider.call).toHaveBeenCalledTimes(3);
    // Verify merge-results received stage outputs (check via the last provider call's messages)
    const lastCallArg = (provider.call.mock.calls[2] as any[])[0];
    const lastCallMessages: any[] = lastCallArg?.messages ?? lastCallArg ?? [];
    const userMsg = lastCallMessages.find((m: any) => m.role === 'user');
    expect(userMsg?.content).toContain('stage-a');
    expect(userMsg?.content).toContain('stage-b');
  });

  it('parallel stages cannot see each other outputs (pre-group snapshot only)', async () => {
    // All parallel stages use context include: [all_stage_outputs]
    // They should only see pre-group stage outputs, not sibling outputs
    writeFileSync(join(PIPELINES_DIR, 'parallel-context-isolation-test.pipeline.yaml'), `
name: parallel-context-isolation-test
description: context isolation test
version: 1
stages:
  - name: pre-stage
    kind: analysis
    agent: test-agent
    contract: basic-result
    ralph:
      max_attempts: 1
      retry_strategy: none
    context:
      include:
        - input
  - group: parallel-work
    mode: parallel
    stages:
      - name: stage-a
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - all_stage_outputs
      - name: stage-b
        kind: analysis
        agent: test-agent
        contract: basic-result
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - all_stage_outputs
`);

    const capturedMessages: Record<string, any[]> = {};
    let callCount = 0;
    const provider = mockProvider((...args: any[]) => {
      callCount++;
      capturedMessages[`call-${callCount}`] = args[0]?.messages ?? args[0] ?? [];
      return successResponse({ call_num: callCount });
    });
    const engine = createEngine(provider);

    await engine.run({ pipeline: 'parallel-context-isolation-test', input: 'Test' });

    // calls 2 and 3 are the parallel stages (stage-a and stage-b)
    // They should see 'pre-stage' output but NOT each other's outputs
    const parallelCall1 = capturedMessages['call-2'];
    const parallelCall2 = capturedMessages['call-3'];

    const msg1 = parallelCall1?.find((m: any) => m.role === 'user')?.content ?? '';
    const msg2 = parallelCall2?.find((m: any) => m.role === 'user')?.content ?? '';

    // Both parallel stages should see pre-stage output
    expect(msg1).toContain('pre-stage');
    expect(msg2).toContain('pre-stage');

    // stage-a should NOT see stage-b output, and vice versa
    expect(msg1).not.toContain('stage-b');
    expect(msg2).not.toContain('stage-a');
  });

  it('emits group lifecycle events with iteration=1', async () => {
    const provider = mockProvider(() => successResponse());
    const events: Array<{ type: string; data: any }> = [];

    const engineEvents: EngineEvents = {
      onGroupStart: (e) => events.push({ type: 'start', data: e }),
      onGroupIteration: (e) => events.push({ type: 'iteration', data: e }),
      onGroupFeedback: (e) => events.push({ type: 'feedback', data: e }),
      onGroupComplete: (e) => events.push({ type: 'complete', data: e }),
      onStageStart: () => {},
      onStageComplete: () => {},
      onPipelineStart: () => {},
      onPipelineComplete: () => {},
    };

    const engine = createEngine(provider, engineEvents);
    await engine.run({ pipeline: 'parallel-test', input: 'Test' });

    expect(events.find(e => e.type === 'start')).toBeDefined();
    expect(events.filter(e => e.type === 'iteration')).toHaveLength(1);
    expect(events.find(e => e.type === 'iteration')?.data.iteration).toBe(1);
    expect(events.find(e => e.type === 'feedback')).toBeUndefined(); // no feedback in parallel
    expect(events.find(e => e.type === 'complete')?.data.status).toBe('success');
  });
});
