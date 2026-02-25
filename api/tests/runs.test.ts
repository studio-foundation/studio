import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio/engine';
import type { RunStore } from '@studio/engine';
import type { RunLauncher } from '../src/launcher.js';
import type { PipelineRun } from '@studio/contracts';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

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

function makeTempLog(lines: string[]): { logPath: string; cleanup: () => void } {
  const dir = resolve(tmpdir(), `studio-test-logs-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const logPath = resolve(dir, 'test.jsonl');
  writeFileSync(logPath, lines.join('\n') + '\n');
  return { logPath, cleanup: () => rmSync(dir, { recursive: true }) };
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

  it('returns structured JSON with parsed entries by default', async () => {
    const { logPath, cleanup } = makeTempLog([
      JSON.stringify({ ts: '2026-01-01T10:00:00Z', event: 'onPipelineStart', pipeline_name: 'feature-builder' }),
      JSON.stringify({ ts: '2026-01-01T10:01:00Z', event: 'onStageComplete', stage_name: 'code-gen', status: 'success' }),
    ]);
    store.savePipelineRun(makeRun({ id: 'run-structured' }));
    store.saveLogPath('run-structured', logPath);
    const server = makeServer(store);

    const res = await server.inject({ method: 'GET', url: '/api/runs/run-structured/logs' });
    cleanup();

    expect(res.statusCode).toBe(200);
    const body = res.json() as { run_id: string; entries: Array<{ event: string; timestamp: string; data: Record<string, unknown> }> };
    expect(body.run_id).toBe('run-structured');
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toEqual({
      event: 'onPipelineStart',
      timestamp: '2026-01-01T10:00:00Z',
      data: { pipeline_name: 'feature-builder' },
    });
    expect(body.entries[1]).toEqual({
      event: 'onStageComplete',
      timestamp: '2026-01-01T10:01:00Z',
      data: { stage_name: 'code-gen', status: 'success' },
    });
  });

  it('returns raw text/plain with ?raw=true', async () => {
    const rawContent = JSON.stringify({ ts: '2026-01-01T10:00:00Z', event: 'onPipelineStart' }) + '\n';
    const { logPath, cleanup } = makeTempLog([rawContent.trimEnd()]);
    store.savePipelineRun(makeRun({ id: 'run-raw' }));
    store.saveLogPath('run-raw', logPath);
    const server = makeServer(store);

    const res = await server.inject({ method: 'GET', url: '/api/runs/run-raw/logs?raw=true' });
    cleanup();

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).toBe(rawContent);
  });

  it('skips malformed JSON lines in structured mode', async () => {
    const { logPath, cleanup } = makeTempLog([
      'not valid json',
      JSON.stringify({ ts: '2026-01-01T10:00:00Z', event: 'onPipelineStart' }),
      '{ broken',
    ]);
    store.savePipelineRun(makeRun({ id: 'run-malformed' }));
    store.saveLogPath('run-malformed', logPath);
    const server = makeServer(store);

    const res = await server.inject({ method: 'GET', url: '/api/runs/run-malformed/logs' });
    cleanup();

    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: unknown[] };
    expect(body.entries).toHaveLength(1);
  });

  it('skips lines without event field in structured mode', async () => {
    const { logPath, cleanup } = makeTempLog([
      JSON.stringify({ ts: '2026-01-01T10:00:00Z', event: 'onPipelineStart' }),
      JSON.stringify({ ts: '2026-01-01T10:00:01Z', some_field: 'no_event_here' }),
    ]);
    store.savePipelineRun(makeRun({ id: 'run-no-event' }));
    store.saveLogPath('run-no-event', logPath);
    const server = makeServer(store);

    const res = await server.inject({ method: 'GET', url: '/api/runs/run-no-event/logs' });
    cleanup();

    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: unknown[] };
    expect(body.entries).toHaveLength(1);
  });

  it('returns empty entries array for empty log file in structured mode', async () => {
    const { logPath, cleanup } = makeTempLog([]);
    store.savePipelineRun(makeRun({ id: 'run-empty-log' }));
    store.saveLogPath('run-empty-log', logPath);
    const server = makeServer(store);

    const res = await server.inject({ method: 'GET', url: '/api/runs/run-empty-log/logs' });
    cleanup();

    expect(res.statusCode).toBe(200);
    const body = res.json() as { run_id: string; entries: unknown[] };
    expect(body.run_id).toBe('run-empty-log');
    expect(body.entries).toHaveLength(0);
  });
});