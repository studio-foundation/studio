import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import type { RunLauncher } from '../src/launcher.js';

const TMP = resolve('/tmp', `studio-sse-test-${Date.now()}`);
mkdirSync(TMP, { recursive: true });

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

function makeDeps(overrides?: Partial<{
  runExists: boolean;
  runStatus: string;
  logPath: string | null;
}>) {
  const { runExists = false, runStatus = 'running', logPath = null } = overrides ?? {};

  const mockStore = {
    getPipelineRun: vi.fn().mockReturnValue(
      runExists
        ? { id: 'run-1', pipeline_name: 'p', status: runStatus, started_at: '', stages: [] }
        : null
    ),
    getLogPath: vi.fn().mockReturnValue(logPath),
    saveLogPath: vi.fn(),
    listPipelineRuns: vi.fn().mockReturnValue([]),
    savePipelineRun: vi.fn(),
    updatePipelineRun: vi.fn(),
    saveStageRun: vi.fn(),
    saveTaskRun: vi.fn(),
  };

  const mockLauncher: RunLauncher = {
    launch: vi.fn().mockResolvedValue({ run_id: 'run-1' }),
    cancel: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };

  return { mockStore, mockLauncher };
}

describe('GET /api/runs/:id/stream', () => {
  it('returns 404 for unknown run', async () => {
    const { mockStore, mockLauncher } = makeDeps({ runExists: false });
    const fastify = buildServer({
      store: mockStore as never,
      launcher: mockLauncher,
      configsDir: TMP,
      projectName: 'test',
      apiConfig: {},
    });

    const res = await fastify.inject({ method: 'GET', url: '/api/runs/unknown-id/stream' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Run not found' });
  });

  it('replays JSONL history and closes for a terminated run', async () => {
    const logFile = resolve(TMP, 'run.jsonl');
    writeFileSync(logFile, [
      JSON.stringify({ ts: '2026-01-01', run_id: 'r1', event: 'stage_complete', stage_name: 'brief-analysis', status: 'success' }),
      JSON.stringify({ ts: '2026-01-01', run_id: 'r1', event: 'pipeline_complete', status: 'success' }),
    ].join('\n') + '\n');

    const { mockStore, mockLauncher } = makeDeps({
      runExists: true,
      runStatus: 'success',
      logPath: logFile,
    });

    const fastify = buildServer({
      store: mockStore as never,
      launcher: mockLauncher,
      configsDir: TMP,
      projectName: 'test',
      apiConfig: {},
    });

    const res = await fastify.inject({ method: 'GET', url: '/api/runs/run-1/stream' });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: stage_complete');
    expect(res.body).toContain('event: pipeline_complete');
  });

  it('filters events by ?events= query param', async () => {
    const logFile = resolve(TMP, 'run-filter.jsonl');
    writeFileSync(logFile, [
      JSON.stringify({ ts: '2026-01-01', run_id: 'r1', event: 'stage_complete', stage_name: 's1' }),
      JSON.stringify({ ts: '2026-01-01', run_id: 'r1', event: 'pipeline_complete', status: 'success' }),
    ].join('\n') + '\n');

    const { mockStore, mockLauncher } = makeDeps({
      runExists: true,
      runStatus: 'success',
      logPath: logFile,
    });

    const fastify = buildServer({
      store: mockStore as never,
      launcher: mockLauncher,
      configsDir: TMP,
      projectName: 'test',
      apiConfig: {},
    });

    const res = await fastify.inject({
      method: 'GET',
      url: '/api/runs/run-1/stream?events=pipeline_complete',
    });

    expect(res.body).not.toContain('event: stage_complete');
    expect(res.body).toContain('event: pipeline_complete');
  });
});
