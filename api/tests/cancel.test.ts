import { describe, it, expect, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio/engine';
import type { RunLauncher } from '../src/launcher.js';
import type { PipelineRun } from '@studio/contracts';
import type { IntegrationRuntime } from '../src/integration-runtime.js';
import type { IntegrationStore } from '../src/integration-store.js';

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'run-abc',
    pipeline_name: 'test-pipeline',
    status: 'running',
    started_at: '2026-01-01T10:00:00Z',
    stages: [],
    ...overrides,
  } as PipelineRun;
}

const nullIntegrationRuntime = { registerRoutes: () => {} } as unknown as IntegrationRuntime;
const nullIntegrationStore = {} as unknown as IntegrationStore;

function makeServer(store = new InMemoryRunStore(), launcher?: Partial<RunLauncher>) {
  return buildServer({
    store,
    launcher: {
      launch: vi.fn().mockResolvedValue({ run_id: 'new-run' }),
      cancel: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockReturnValue(() => {}),
      ...launcher,
    } as RunLauncher,
    configsDir: '/tmp/.studio',
    projectName: 'test',
    apiConfig: {},
    integrationRuntime: nullIntegrationRuntime,
    integrationStore: nullIntegrationStore,
  } as any);
}

describe('POST /api/runs/:id/cancel', () => {
  it('returns 200 with run_id when run is running', async () => {
    const store = new InMemoryRunStore();
    const cancelFn = vi.fn().mockResolvedValue(undefined);
    store.savePipelineRun(makeRun({ id: 'run-1', status: 'running' }));
    const server = makeServer(store, { cancel: cancelFn });

    const res = await server.inject({ method: 'POST', url: '/api/runs/run-1/cancel' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ run_id: 'run-1' });
    expect(cancelFn).toHaveBeenCalledWith('run-1');
  });

  it('returns 404 when run does not exist', async () => {
    const server = makeServer();

    const res = await server.inject({ method: 'POST', url: '/api/runs/nonexistent/cancel' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it('returns 409 when run is already success', async () => {
    const store = new InMemoryRunStore();
    store.savePipelineRun(makeRun({ id: 'run-done', status: 'success' }));
    const server = makeServer(store);

    const res = await server.inject({ method: 'POST', url: '/api/runs/run-done/cancel' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not cancellable/i);
  });

  it('returns 409 for failed and cancelled statuses', async () => {
    for (const status of ['failed', 'cancelled'] as const) {
      const store = new InMemoryRunStore();
      store.savePipelineRun(makeRun({ id: 'run-x', status }));
      const server = makeServer(store);

      const res = await server.inject({ method: 'POST', url: '/api/runs/run-x/cancel' });

      expect(res.statusCode).toBe(409);
    }
  });
});

describe('DELETE /api/runs/:id', () => {
  it('returns 200 with run_id when run is running', async () => {
    const store = new InMemoryRunStore();
    const cancelFn = vi.fn().mockResolvedValue(undefined);
    store.savePipelineRun(makeRun({ id: 'run-del-1', status: 'running' }));
    const server = makeServer(store, { cancel: cancelFn });

    const res = await server.inject({ method: 'DELETE', url: '/api/runs/run-del-1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ run_id: 'run-del-1' });
    expect(cancelFn).toHaveBeenCalledWith('run-del-1');
  });

  it('returns 404 when run does not exist', async () => {
    const server = makeServer();

    const res = await server.inject({ method: 'DELETE', url: '/api/runs/nonexistent' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it('returns 409 when run is already terminal', async () => {
    const store = new InMemoryRunStore();
    store.savePipelineRun(makeRun({ id: 'run-done', status: 'success' }));
    const server = makeServer(store);

    const res = await server.inject({ method: 'DELETE', url: '/api/runs/run-done' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not cancellable/i);
  });
});
