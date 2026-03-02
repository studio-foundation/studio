import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { PipelineEngine, type EngineConfig, type RunInput } from '../../src/engine.js';
import { InMemoryRunStore } from '../../src/state/run-store.js';
import type { EngineEvents } from '../../src/events.js';
import { ToolRegistry } from '@studio/runner';

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

  // Fixtures for maximum-only tool_calls contract
  writeFileSync(join(CONTRACTS_DIR, 'maximum-only.contract.yaml'), `
name: maximum-only
version: 1
schema:
  required_fields:
    - summary
tool_calls:
  maximum: 2
`);
  writeFileSync(join(PIPELINES_DIR, 'maximum-only.pipeline.yaml'), `
name: maximum-only
description: Pipeline with a contract that only sets maximum tool_calls
version: 1
stages:
  - name: analysis
    kind: analysis
    agent: test-agent
    contract: maximum-only
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

  writeFileSync(join(PIPELINES_DIR, 'group-simple.pipeline.yaml'), `
name: group-simple
description: Pipeline with a simple group for cancellation testing
version: 1
stages:
  - group: review-loop
    max_iterations: 2
    stages:
      - name: review-stage-1
        kind: analysis
        agent: test-agent
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
      - name: review-stage-2
        kind: analysis
        agent: test-agent
        ralph:
          max_attempts: 1
          retry_strategy: none
        context:
          include:
            - input
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

  it('cancels cleanly when signal is aborted while a stage is executing', async () => {
    const controller = new AbortController();

    // Make the provider slow (100ms) and signal-aware so raceSignal can interrupt it
    const slowProvider = {
      name: 'anthropic',
      call: vi.fn().mockImplementation(
        (_req: unknown, _onToken: unknown, signal?: AbortSignal) => {
          const slowPromise = new Promise<{
            content: string;
            tool_calls: unknown[];
            finish_reason: string;
            usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          }>((resolve) =>
            setTimeout(() => resolve({
              content: JSON.stringify({ summary: 'done', requirements: [], acceptance_criteria: [] }),
              tool_calls: [],
              finish_reason: 'stop',
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }), 100)
          );

          // Race the slow promise against the abort signal
          if (!signal) return slowPromise;
          if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
          return new Promise((resolve, reject) => {
            const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
            signal.addEventListener('abort', onAbort, { once: true });
            slowPromise
              .then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); })
              .catch((e) => { signal.removeEventListener('abort', onAbort); reject(e); });
          });
        }
      ),
    };

    const engine = createTestEngine({
      providerRegistry: { get: vi.fn().mockReturnValue(slowProvider), register: vi.fn() } as any,
    });

    // Abort after 10ms (before the 100ms provider resolves)
    setTimeout(() => controller.abort(), 10);

    const result = await engine.run({
      pipeline: 'simple',
      input: 'test input',
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
  });

  it('cancels between stages when signal is aborted after first stage completes', async () => {
    const controller = new AbortController();
    let stage1Completed = false;

    const events: EngineEvents = {
      onStageComplete: (e) => {
        if (e.stage_name === 'stage-1') {
          stage1Completed = true;
          controller.abort(); // abort after stage 1 finishes
        }
      },
    };

    const engine = new PipelineEngine(
      {
        configsDir: PROJECT_DIR,
        providerRegistry: createMockProviderRegistry() as any,
        toolRegistry: createMockToolRegistry() as any,
        db: new InMemoryRunStore(),
      },
      events
    );

    const result = await engine.run({
      pipeline: 'two-stage',
      input: 'test input',
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(stage1Completed).toBe(true);
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].stage_name).toBe('stage-1');
    expect(result.stages[0].status).toBe('success');
  });

  it('cancels cleanly when signal is aborted during a group stage', async () => {
    const controller = new AbortController();

    // Slow provider that respects the abort signal mid-call
    const slowProvider = {
      name: 'anthropic',
      call: vi.fn().mockImplementation(
        (_req: unknown, _onToken: unknown, signal?: AbortSignal) => {
          const slowPromise = new Promise<{
            content: string;
            tool_calls: unknown[];
            finish_reason: string;
            usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          }>((resolve) =>
            setTimeout(() => resolve({
              content: JSON.stringify({ summary: 'done', requirements: [], acceptance_criteria: [] }),
              tool_calls: [],
              finish_reason: 'stop',
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }), 100)
          );

          if (!signal) return slowPromise;
          if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
          return new Promise((resolve, reject) => {
            const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
            signal.addEventListener('abort', onAbort, { once: true });
            slowPromise
              .then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); })
              .catch((e) => { signal.removeEventListener('abort', onAbort); reject(e); });
          });
        }
      ),
    };

    const engine = createTestEngine({
      providerRegistry: { get: vi.fn().mockReturnValue(slowProvider), register: vi.fn() } as any,
    });

    // Abort after 10ms (before the 100ms provider resolves)
    setTimeout(() => controller.abort(), 10);

    const result = await engine.run({
      pipeline: 'group-simple',
      input: 'test input',
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
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

  it('fails stage when tool_calls maximum is exceeded (maximum-only contract)', async () => {
    // A contract with only `maximum: 2` and no `minimum`.
    // Before the guard fix, this validator was silently skipped.
    // After the fix it must be activated and fail when 3 successful tool calls are made.

    // Create a real ToolRegistry with a succeeding test tool
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'test-tool',
      description: 'A simple test tool',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => ({ success: true, output: 'ok' }),
    });

    // Mock provider: returns 3 tool calls on the first call, then valid output
    let callCount = 0;
    const provider = {
      name: 'anthropic',
      call: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First turn: 3 tool calls (exceeds maximum of 2)
          return {
            content: '',
            tool_calls: [
              { id: 'tc-1', name: 'test-tool', arguments: {} },
              { id: 'tc-2', name: 'test-tool', arguments: {} },
              { id: 'tc-3', name: 'test-tool', arguments: {} },
            ],
            finish_reason: 'tool_calls',
          };
        }
        // Second turn: final response with valid output
        return {
          content: JSON.stringify({ summary: 'done' }),
          tool_calls: [],
          finish_reason: 'stop',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        };
      }),
    };

    const engine = new PipelineEngine({
      configsDir: PROJECT_DIR,
      providerRegistry: { get: vi.fn().mockReturnValue(provider), register: vi.fn() } as any,
      toolRegistry: toolRegistry as any,
      db: new InMemoryRunStore(),
    });

    const result = await engine.run({ pipeline: 'maximum-only', input: 'test maximum' });

    expect(result.status).toBe('failed');
    expect(result.stages[0].status).toBe('failed');
  });

  it('succeeds stage when tool_calls count is within maximum (maximum-only contract)', async () => {
    // Same contract (maximum: 2), but only 1 tool call made — should pass.

    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'test-tool',
      description: 'A simple test tool',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => ({ success: true, output: 'ok' }),
    });

    let callCount = 0;
    const provider = {
      name: 'anthropic',
      call: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First turn: 1 tool call (within maximum of 2)
          return {
            content: '',
            tool_calls: [
              { id: 'tc-1', name: 'test-tool', arguments: {} },
            ],
            finish_reason: 'tool_calls',
          };
        }
        // Second turn: final response with valid output
        return {
          content: JSON.stringify({ summary: 'done' }),
          tool_calls: [],
          finish_reason: 'stop',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        };
      }),
    };

    const engine = new PipelineEngine({
      configsDir: PROJECT_DIR,
      providerRegistry: { get: vi.fn().mockReturnValue(provider), register: vi.fn() } as any,
      toolRegistry: toolRegistry as any,
      db: new InMemoryRunStore(),
    });

    const result = await engine.run({ pipeline: 'maximum-only', input: 'test maximum within bounds' });

    expect(result.status).toBe('success');
    expect(result.stages[0].status).toBe('success');
  });
});
