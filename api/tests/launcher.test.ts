import { describe, it, expect, vi, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { InProcessLauncher } from '../src/launcher.js';
import { RunEventBus } from '../src/event-bus.js';
import { InMemoryRunStore } from '@studio/engine';
import type { EngineConfig, EngineEvents } from '@studio/engine';

const TMP_RUNS_DIR = resolve('/tmp', `studio-launcher-test-${Date.now()}`);

afterAll(() => {
  rmSync(TMP_RUNS_DIR, { recursive: true, force: true });
});

// Minimal EngineConfig stub — launcher only passes it to engineFactory
const stubConfig = {} as EngineConfig;

function makeMockFactory(onEvents?: (events: EngineEvents) => void) {
  const runFn = vi.fn().mockResolvedValue({
    id: 'test-run-id',
    pipeline_name: 'test-pipeline',
    status: 'success',
    started_at: new Date().toISOString(),
    stages: [],
  });
  const factory = vi.fn().mockImplementation((_cfg: EngineConfig, events: EngineEvents) => {
    onEvents?.(events);
    return { run: runFn };
  });
  return { factory, runFn };
}

describe('InProcessLauncher', () => {
  it('launch returns run_id immediately (fire-and-forget)', async () => {
    let engineStarted = false;
    let engineCompleted = false;
    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    const { factory } = makeMockFactory();
    factory.mockImplementation(() => ({
      run: vi.fn().mockImplementation(async () => {
        engineStarted = true;
        await new Promise((r) => setTimeout(r, 50));
        engineCompleted = true;
        return { id: 'run-1', pipeline_name: 'p', status: 'success', started_at: '', stages: [] };
      }),
    }));

    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);
    const result = await launcher.launch({
      runId: 'run-1',
      pipeline: 'test-pipeline',
      input: {},
      configsDir: TMP_RUNS_DIR,
    });

    expect(result.run_id).toBe('run-1');
    expect(engineStarted).toBe(true);
    expect(engineCompleted).toBe(false);
  });

  it('saves log path to store immediately after launch', async () => {
    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    const { factory } = makeMockFactory();
    factory.mockImplementation(() => ({
      run: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { id: 'run-log', pipeline_name: 'p', status: 'success', started_at: '', stages: [] };
      }),
    }));

    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);
    await launcher.launch({ runId: 'run-log', pipeline: 'test-pipeline', input: {}, configsDir: TMP_RUNS_DIR });

    const logPath = store.getLogPath('run-log');
    expect(logPath).not.toBeNull();
    expect(logPath).toContain('test-pipeline');
    expect(logPath).toContain('.jsonl');
  });

  it('subscribe delivers events emitted during a run', async () => {
    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    let capturedEvents: EngineEvents = {};

    const { factory } = makeMockFactory((evts) => { capturedEvents = evts; });
    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);

    const received: string[] = [];
    launcher.subscribe('run-evt', ({ type }) => received.push(type));

    await launcher.launch({ runId: 'run-evt', pipeline: 'p', input: {}, configsDir: TMP_RUNS_DIR });

    // Simulate engine emitting events
    capturedEvents.onStageComplete?.({ stage_name: 's', stage_index: 0, total_stages: 1, status: 'success', attempts: 1, duration_ms: 100 });
    capturedEvents.onPipelineComplete?.({ pipeline_name: 'p', run_id: 'run-evt', status: 'success', duration_ms: 200, total_tokens: 100, total_tool_calls: 0 });

    expect(received).toContain('stage_complete');
    expect(received).toContain('pipeline_complete');
    expect(received).toContain('done'); // bus.close called after pipeline_complete
  });

  it('cancel aborts a running pipeline', async () => {
    let abortSeen = false;
    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    const { factory } = makeMockFactory();
    factory.mockImplementation(() => ({
      run: vi.fn().mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
        await new Promise((r) => setTimeout(r, 200));
        abortSeen = signal?.aborted ?? false;
        return { id: 'run-cancel', pipeline_name: 'p', status: 'failed', started_at: '', stages: [] };
      }),
    }));

    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);
    await launcher.launch({ runId: 'run-cancel', pipeline: 'p', input: {}, configsDir: TMP_RUNS_DIR });
    await launcher.cancel('run-cancel');
    await new Promise((r) => setTimeout(r, 250));
    expect(abortSeen).toBe(true);
  });

  it('cancel ignores unknown run_id', async () => {
    const launcher = new InProcessLauncher(stubConfig, new InMemoryRunStore(), TMP_RUNS_DIR, new RunEventBus());
    await expect(launcher.cancel('nonexistent')).resolves.toBeUndefined();
  });
});

describe('InProcessLauncher — Linear failure notification (STU-98)', () => {
  it('pipeline_complete bus event includes meta and last_group_feedback when pipeline fails', async () => {
    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    let capturedEvents: EngineEvents = {};

    const { factory } = makeMockFactory((evts) => { capturedEvents = evts; });
    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);

    const received: Array<{ type: string; data: unknown }> = [];
    launcher.subscribe('run-fail-linear', ({ type, data }) => received.push({ type, data }));

    await launcher.launch({
      runId: 'run-fail-linear',
      pipeline: 'feature-builder',
      input: {},
      configsDir: TMP_RUNS_DIR,
      meta: { linear_issue_id: 'issue-abc-123' },
    });

    // Simulate group feedback then pipeline failure
    capturedEvents.onGroupFeedback?.({
      group_name: 'implementation-review',
      iteration: 3,
      rejection_reason: 'QA rejected the code',
      rejection_details: ['Hardcoded strings (blocking)', 'Missing error handling (blocking)'],
    });
    capturedEvents.onPipelineComplete?.({
      pipeline_name: 'feature-builder',
      run_id: 'run-fail-linear',
      status: 'rejected',
      duration_ms: 180000,
      total_tokens: 5000,
      total_tool_calls: 12,
    });

    await new Promise((r) => setTimeout(r, 10));

    const pipelineCompleteEvent = received.find(e => e.type === 'pipeline_complete');
    expect(pipelineCompleteEvent).toBeDefined();
    const data = pipelineCompleteEvent!.data as Record<string, unknown>;
    expect(data['meta']).toEqual({ linear_issue_id: 'issue-abc-123' });
    expect(data['last_group_feedback']).toMatchObject({
      group_name: 'implementation-review',
      iteration: 3,
      rejection_reason: 'QA rejected the code',
      rejection_details: ['Hardcoded strings (blocking)', 'Missing error handling (blocking)'],
    });
  });

  it('pipeline_complete bus event includes meta with no last_group_feedback when no group feedback occurred', async () => {
    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    let capturedEvents: EngineEvents = {};

    const { factory } = makeMockFactory((evts) => { capturedEvents = evts; });
    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);

    const received: Array<{ type: string; data: unknown }> = [];
    launcher.subscribe('run-fail-no-feedback', ({ type, data }) => received.push({ type, data }));

    await launcher.launch({
      runId: 'run-fail-no-feedback',
      pipeline: 'feature-builder',
      input: {},
      configsDir: TMP_RUNS_DIR,
      meta: { linear_issue_id: 'issue-xyz' },
    });

    // No onGroupFeedback fired — a stage failed directly
    capturedEvents.onPipelineComplete?.({
      pipeline_name: 'feature-builder',
      run_id: 'run-fail-no-feedback',
      status: 'failed',
      duration_ms: 30000,
      total_tokens: 500,
      total_tool_calls: 2,
    });

    await new Promise((r) => setTimeout(r, 10));

    const pipelineCompleteEvent = received.find(e => e.type === 'pipeline_complete');
    expect(pipelineCompleteEvent).toBeDefined();
    const data = pipelineCompleteEvent!.data as Record<string, unknown>;
    expect(data['meta']).toEqual({ linear_issue_id: 'issue-xyz' });
    expect(data['last_group_feedback']).toBeUndefined();
  });
});

describe('InProcessLauncher — tool call SSE events (STU-174)', () => {
  it('emits tool_call_start event when engine fires onToolCallStart', async () => {
    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    let capturedEvents: EngineEvents = {};

    const { factory } = makeMockFactory((evts) => { capturedEvents = evts; });
    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);

    const received: Array<{ type: string; data: unknown }> = [];
    launcher.subscribe('stu174-tool-s', ({ type, data }) => received.push({ type, data }));

    await launcher.launch({ runId: 'stu174-tool-s', pipeline: 'p', input: {}, configsDir: TMP_RUNS_DIR });

    capturedEvents.onToolCallStart?.({
      stage: 'code-generation',
      tool: 'repo_manager-write_file',
      params: { path: 'src/foo.ts' },
      timestamp: 1700000000000,
    } as never);

    // Close the logger cleanly before assertions
    capturedEvents.onPipelineComplete?.({ pipeline_name: 'p', run_id: 'stu174-tool-s', status: 'success', duration_ms: 10, total_tokens: 0, total_tool_calls: 1 });
    await new Promise((r) => setTimeout(r, 10));

    expect(received.map(e => e.type)).toContain('tool_call_start');
    const evt = received.find(e => e.type === 'tool_call_start')?.data;
    expect(evt).toMatchObject({ stage: 'code-generation', tool: 'repo_manager-write_file' });
  });

  it('emits tool_call_complete event when engine fires onToolCallComplete', async () => {
    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    let capturedEvents: EngineEvents = {};

    const { factory } = makeMockFactory((evts) => { capturedEvents = evts; });
    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);

    const received: Array<{ type: string; data: unknown }> = [];
    launcher.subscribe('stu174-tool-c', ({ type, data }) => received.push({ type, data }));

    await launcher.launch({ runId: 'stu174-tool-c', pipeline: 'p', input: {}, configsDir: TMP_RUNS_DIR });

    capturedEvents.onToolCallComplete?.({
      stage: 'code-generation',
      tool: 'repo_manager-write_file',
      result: 'written',
      duration_ms: 100,
      timestamp: 1700000000000,
    } as never);

    // Close the logger cleanly before assertions
    capturedEvents.onPipelineComplete?.({ pipeline_name: 'p', run_id: 'stu174-tool-c', status: 'success', duration_ms: 10, total_tokens: 0, total_tool_calls: 1 });
    await new Promise((r) => setTimeout(r, 10));

    expect(received.map(e => e.type)).toContain('tool_call_complete');
    const evt = received.find(e => e.type === 'tool_call_complete')?.data;
    expect(evt).toMatchObject({ stage: 'code-generation', tool: 'repo_manager-write_file', duration_ms: 100 });
  });
});
