import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { PipelineEngine, type EngineConfig, type RunInput } from '../src/engine.js';
import { InMemoryRunStore } from '../src/state/run-store.js';
import type { EngineEvents } from '../src/events.js';

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

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');
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
});
