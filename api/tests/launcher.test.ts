import { describe, it, expect, vi, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { InProcessLauncher } from '../src/launcher.js';
import { RunEventBus } from '../src/event-bus.js';
import { InMemoryRunStore } from '@studio/engine';
import type { EngineConfig, EngineEvents } from '@studio/engine';

// Mock linear-notifier so tests don't hit the network
vi.mock('../src/linear-notifier.js', () => ({
  notifyLinearFailure: vi.fn().mockResolvedValue(undefined),
}));

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
  it('calls notifyLinearFailure when pipeline fails with linear_issue_id in meta', async () => {
    const { notifyLinearFailure } = await import('../src/linear-notifier.js');
    const notifyMock = vi.mocked(notifyLinearFailure);
    notifyMock.mockClear();

    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    let capturedEvents: EngineEvents = {};

    const { factory } = makeMockFactory((evts) => { capturedEvents = evts; });
    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);

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

    // notifyLinearFailure is called async (fire-and-forget) — wait a tick
    await new Promise((r) => setTimeout(r, 10));

    expect(notifyMock).toHaveBeenCalledOnce();
    expect(notifyMock).toHaveBeenCalledWith({
      issueId: 'issue-abc-123',
      runId: 'run-fail-linear',
      durationMs: 180000,
      iterations: 3,
      rejectionReason: 'QA rejected the code',
      rejectionDetails: ['Hardcoded strings (blocking)', 'Missing error handling (blocking)'],
    });
  });

  it('does NOT call notifyLinearFailure when pipeline succeeds', async () => {
    const { notifyLinearFailure } = await import('../src/linear-notifier.js');
    const notifyMock = vi.mocked(notifyLinearFailure);
    notifyMock.mockClear();

    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    let capturedEvents: EngineEvents = {};

    const { factory } = makeMockFactory((evts) => { capturedEvents = evts; });
    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);

    await launcher.launch({
      runId: 'run-success-linear',
      pipeline: 'feature-builder',
      input: {},
      configsDir: TMP_RUNS_DIR,
      meta: { linear_issue_id: 'issue-abc-123' },
    });

    capturedEvents.onPipelineComplete?.({
      pipeline_name: 'feature-builder',
      run_id: 'run-success-linear',
      status: 'success',
      duration_ms: 120000,
      total_tokens: 3000,
      total_tool_calls: 8,
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('does NOT call notifyLinearFailure when meta has no linear_issue_id', async () => {
    const { notifyLinearFailure } = await import('../src/linear-notifier.js');
    const notifyMock = vi.mocked(notifyLinearFailure);
    notifyMock.mockClear();

    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    let capturedEvents: EngineEvents = {};

    const { factory } = makeMockFactory((evts) => { capturedEvents = evts; });
    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);

    await launcher.launch({
      runId: 'run-no-meta',
      pipeline: 'feature-builder',
      input: {},
      configsDir: TMP_RUNS_DIR,
      // no meta
    });

    capturedEvents.onPipelineComplete?.({
      pipeline_name: 'feature-builder',
      run_id: 'run-no-meta',
      status: 'rejected',
      duration_ms: 60000,
      total_tokens: 1000,
      total_tool_calls: 4,
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('passes undefined rejection fields when no group feedback occurred', async () => {
    const { notifyLinearFailure } = await import('../src/linear-notifier.js');
    const notifyMock = vi.mocked(notifyLinearFailure);
    notifyMock.mockClear();

    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    let capturedEvents: EngineEvents = {};

    const { factory } = makeMockFactory((evts) => { capturedEvents = evts; });
    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory);

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

    expect(notifyMock).toHaveBeenCalledWith({
      issueId: 'issue-xyz',
      runId: 'run-fail-no-feedback',
      durationMs: 30000,
      iterations: undefined,
      rejectionReason: undefined,
      rejectionDetails: undefined,
    });
  });
});
