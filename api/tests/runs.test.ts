import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio/engine';
import type { RunStore } from '@studio/engine';
import type { RunLauncher } from '../src/launcher.js';
import type { PipelineRun } from '@studio/contracts';

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'run-abc123',
    pipeline_name: 'feature-builder',
    status: 'success',
    started_at: '2026-01-01T10:00:00Z',
    completed_at: '2026-01-01T10:01:00Z',
    stages: [],
    ...overrides,
  } as PipelineRun;
}

function makeServer(store: RunStore, launcher?: RunLauncher) {
  return buildServer({
    store,
    launcher: launcher ?? { launch: async () => ({ run_id: 'new-run' }), cancel: async () => {} },
    configsDir: '/tmp/.studio',
    projectName: 'test',
    apiConfig: {},
  });
}

describe('POST /api/runs', () => {
  it('returns 201 with run_id and status running', async () => {
    const store = new InMemoryRunStore();
    const launcher = { launch: vi.fn().mockResolvedValue({ run_id: 'generated-id' }), cancel: vi.fn() };
    const server = makeServer(store, launcher);

    const res = await server.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { pipeline: 'feature-builder', input: { brief: 'Add FAQ' } },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.run_id).toBe('generated-id');
    expect(body.status).toBe('running');
    expect(body.stream_url).toBe('/api/runs/generated-id/stream');
  });

  it('returns 400 if pipeline is missing', async () => {
    const server = makeServer(new InMemoryRunStore());
    const res = await server.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { input: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 if input is missing', async () => {
    const server = makeServer(new InMemoryRunStore());
    const res = await server.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { pipeline: 'test' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/runs', () => {
  it('returns empty list when no runs', async () => {
    const server = makeServer(new InMemoryRunStore());
    const res = await server.inject({ method: 'GET', url: '/api/runs' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ runs: [] });
  });

  it('returns saved runs', async () => {
    const store = new InMemoryRunStore();
    store.savePipelineRun(makeRun({ id: 'run-1' }));
    store.savePipelineRun(makeRun({ id: 'run-2', status: 'running' }));
    const server = makeServer(store);

    const res = await server.inject({ method: 'GET', url: '/api/runs' });
    expect(res.statusCode).toBe(200);
    const { runs } = res.json() as { runs: PipelineRun[] };
    expect(runs).toHaveLength(2);
  });

  it('filters by status query param', async () => {
    const store = new InMemoryRunStore();
    store.savePipelineRun(makeRun({ id: 'r1', status: 'success' }));
    store.savePipelineRun(makeRun({ id: 'r2', status: 'running' }));
    const server = makeServer(store);

    const res = await server.inject({ method: 'GET', url: '/api/runs?status=success' });
    const { runs } = res.json() as { runs: PipelineRun[] };
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe('r1');
  });

  it('respects limit query param', async () => {
    const store = new InMemoryRunStore();
    for (let i = 0; i < 5; i++) {
      store.savePipelineRun(makeRun({ id: `run-${i}` }));
    }
    const server = makeServer(store);

    const res = await server.inject({ method: 'GET', url: '/api/runs?limit=2' });
    const { runs } = res.json() as { runs: PipelineRun[] };
    expect(runs).toHaveLength(2);
  });
});

describe('GET /api/runs/:id', () => {
  it('returns the run by id', async () => {
    const store = new InMemoryRunStore();
    store.savePipelineRun(makeRun({ id: 'target-run' }));
    const server = makeServer(store);

    const res = await server.inject({ method: 'GET', url: '/api/runs/target-run' });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('target-run');
  });

  it('returns 404 for unknown run', async () => {
    const server = makeServer(new InMemoryRunStore());
    const res = await server.inject({ method: 'GET', url: '/api/runs/nonexistent' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/runs/:id/logs', () => {
  let store: InMemoryRunStore;

  beforeEach(() => {
    store = new InMemoryRunStore();
  });

  it('returns 404 if run not found', async () => {
    const server = makeServer(store);
    const res = await server.inject({ method: 'GET', url: '/api/runs/unknown/logs' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it('returns 404 if run exists but log not yet available', async () => {
    store.savePipelineRun(makeRun({ id: 'run-nolog' }));
    // No saveLogPath call
    const server = makeServer(store);

    const res = await server.inject({ method: 'GET', url: '/api/runs/run-nolog/logs' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not yet available/i);
  });

  it('returns 404 if log path saved but file does not exist', async () => {
    store.savePipelineRun(makeRun({ id: 'run-missing-file' }));
    store.saveLogPath('run-missing-file', '/tmp/nonexistent-log.jsonl');
    const server = makeServer(store);

    const res = await server.inject({ method: 'GET', url: '/api/runs/run-missing-file/logs' });
    expect(res.statusCode).toBe(404);
  });
});
