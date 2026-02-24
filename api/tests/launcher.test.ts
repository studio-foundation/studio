import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InProcessLauncher } from '../src/launcher.js';
import { InMemoryRunStore } from '@studio/engine';

describe('InProcessLauncher', () => {
  let store: InMemoryRunStore;
  let mockEngine: { run: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    store = new InMemoryRunStore();
    mockEngine = {
      run: vi.fn().mockResolvedValue({
        id: 'test-run-id',
        pipeline_name: 'test-pipeline',
        status: 'success',
        started_at: new Date().toISOString(),
        stages: [],
      }),
    };
  });

  it('launch returns run_id immediately without waiting for completion', async () => {
    let engineStarted = false;
    let engineCompleted = false;

    mockEngine.run = vi.fn().mockImplementation(async () => {
      engineStarted = true;
      await new Promise(resolve => setTimeout(resolve, 50));
      engineCompleted = true;
      return {
        id: 'pre-generated-id',
        pipeline_name: 'test-pipeline',
        status: 'success',
        started_at: new Date().toISOString(),
        stages: [],
      };
    });

    const launcher = new InProcessLauncher(mockEngine as never, store, '/tmp/.studio');
    const result = await launcher.launch({
      runId: 'pre-generated-id',
      pipeline: 'test-pipeline',
      input: { key: 'value' },
      configsDir: '/tmp/.studio',
    });

    expect(result.run_id).toBe('pre-generated-id');
    expect(engineStarted).toBe(true);
    expect(engineCompleted).toBe(false); // fire-and-forget: engine pas encore fini
  });

  it('saves log path to store immediately after launch', async () => {
    mockEngine.run = vi.fn().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { id: 'run-abc', pipeline_name: 'p', status: 'success', started_at: '', stages: [] };
    });

    const launcher = new InProcessLauncher(mockEngine as never, store, '/tmp/.studio/runs');
    await launcher.launch({
      runId: 'run-abc',
      pipeline: 'test-pipeline',
      input: {},
      configsDir: '/tmp/.studio',
    });

    const logPath = store.getLogPath('run-abc');
    expect(logPath).not.toBeNull();
    expect(logPath).toContain('test-pipeline');
    expect(logPath).toContain('.jsonl');
  });

  it('cancel aborts a running pipeline', async () => {
    let abortSignalSeen = false;
    mockEngine.run = vi.fn().mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      await new Promise(resolve => setTimeout(resolve, 200));
      abortSignalSeen = signal?.aborted ?? false;
      return { id: 'run-cancel', pipeline_name: 'p', status: 'failed', started_at: '', stages: [] };
    });

    const launcher = new InProcessLauncher(mockEngine as never, store, '/tmp/.studio/runs');
    await launcher.launch({
      runId: 'run-cancel',
      pipeline: 'test-pipeline',
      input: {},
      configsDir: '/tmp/.studio',
    });

    await launcher.cancel('run-cancel');
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(abortSignalSeen).toBe(true);
  });

  it('cancel ignores unknown run_id', async () => {
    const launcher = new InProcessLauncher(mockEngine as never, store, '/tmp/.studio/runs');
    await expect(launcher.cancel('nonexistent')).resolves.toBeUndefined();
  });
});
