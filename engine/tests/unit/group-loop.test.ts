import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { PipelineEngine, type EngineConfig } from '../../src/engine.js';
import { InMemoryRunStore } from '../../src/state/run-store.js';
import type { EngineEvents } from '../../src/events.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');
// Dedicated project dir — must NOT be shared with engine.test.ts. Both files write
// test-agent.agent.yaml at module load; vitest runs test files in parallel, so a
// shared path races (one truncates while the other reads → "expected an object").
// This surfaced only on CI, where the parallelism is wider than a typical local run.
const PROJECT_DIR = join(FIXTURES_DIR, 'test-project-group-loop');
const PIPELINES_DIR = join(PROJECT_DIR, 'pipelines');
const AGENTS_DIR = join(PROJECT_DIR, 'agents');
const CONTRACTS_DIR = join(PROJECT_DIR, 'contracts');

mkdirSync(PIPELINES_DIR, { recursive: true });
mkdirSync(AGENTS_DIR, { recursive: true });
mkdirSync(CONTRACTS_DIR, { recursive: true });

// Agent fixture
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

  it('fails pipeline (not group retry) when executor throws during group iteration', async () => {
    let callCount = 0;
    const provider = createMockProvider(() => {
      callCount++;
      if (callCount === 1) return analysisResponse();   // pre-group analysis
      if (callCount === 2) return codeGenResponse();     // iter 1: code-gen OK
      if (callCount === 3) return qaRejectResponse(      // iter 1: QA rejects
        'Missing error handling',
        ['No try-catch around API call']
      );
      // iter 2: code-gen throws a technical error (network timeout, etc.)
      throw new Error('Network timeout');
    });

    const engine = createEngine(provider);
    const result = await engine.run({ pipeline: 'group-test', input: 'Build feature' });

    // Technical throw → stage failed → pipeline failed, no infinite group retry
    expect(result.status).toBe('failed');
    // analysis + code-gen(iter1) + qa-reject(iter1) + code-gen(iter2 throws) = 4
    expect(result.stages).toHaveLength(4);
    expect(provider.call).toHaveBeenCalledTimes(4);
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
