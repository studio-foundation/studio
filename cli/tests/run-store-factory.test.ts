import { describe, it, expect, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { createRunStore } from '../src/run-store-factory.js';
import type { PipelineRun } from '@studio/contracts';

const tmpDir = `/tmp/.studio-factory-test-${Date.now()}`;

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('createRunStore', () => {
  it('returns a RunStore that can round-trip a PipelineRun', async () => {
    const store = await createRunStore({ resolvedStudioDir: tmpDir });

    const run: PipelineRun = {
      id: 'abc-123',
      pipeline_name: 'test-pipeline',
      status: 'success',
      started_at: '2026-01-01T00:00:00.000Z',
      stages: [],
    };

    await store.savePipelineRun(run);
    const retrieved = await store.getPipelineRun('abc-123');

    expect(retrieved?.id).toBe('abc-123');
    expect(retrieved?.pipeline_name).toBe('test-pipeline');
    expect(retrieved?.status).toBe('success');

    await store.close?.();
  });

  it('saves and retrieves log path', async () => {
    const store = await createRunStore({ resolvedStudioDir: tmpDir });

    const run: PipelineRun = {
      id: 'log-run',
      pipeline_name: 'p',
      status: 'success',
      started_at: '2026-01-01T00:00:00.000Z',
      stages: [],
    };
    await store.savePipelineRun(run);
    await store.saveLogPath('log-run', '/tmp/some.jsonl');

    expect(await store.getLogPath('log-run')).toBe('/tmp/some.jsonl');

    await store.close?.();
  });
});
