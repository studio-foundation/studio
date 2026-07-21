import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { SQLiteRunStore, PgRunStore, InMemoryRunStore } from './run-store.js';
import type { PipelineRun } from '@studio-foundation/contracts';

// A pid beyond Linux pid_max can never name a live process, so kill(pid, 0)
// reports ESRCH — a deterministic stand-in for a dead owner.
const DEAD_PID = 2 ** 31 - 2;

function makeRun(overrides?: Partial<PipelineRun>): PipelineRun {
  return {
    id: 'run-1',
    pipeline_name: 'test-pipeline',
    status: 'running',
    started_at: '2026-01-01T00:00:00.000Z',
    stages: [],
    ...overrides,
  };
}

describe('SQLiteRunStore', () => {
  describe('saveLogPath / getLogPath', () => {
    it('returns null when no log path has been set', () => {
      const store = new SQLiteRunStore(':memory:');
      store.savePipelineRun(makeRun());
      expect(store.getLogPath('run-1')).toBeNull();
    });

    it('returns the log path after saveLogPath', () => {
      const store = new SQLiteRunStore(':memory:');
      store.savePipelineRun(makeRun());
      store.saveLogPath('run-1', '/tmp/run-1.jsonl');
      expect(store.getLogPath('run-1')).toBe('/tmp/run-1.jsonl');
    });

    it('preserves log_path when savePipelineRun is called again after saveLogPath', () => {
      // Regression for STU-150: savePipelineRun used INSERT OR REPLACE which clobbers log_path
      const store = new SQLiteRunStore(':memory:');
      store.savePipelineRun(makeRun());
      store.saveLogPath('run-1', '/tmp/run-1.jsonl');

      // Simulate engine completing the run (this triggered the bug)
      store.savePipelineRun(makeRun({ status: 'success', completed_at: '2026-01-01T00:01:00.000Z' }));

      expect(store.getLogPath('run-1')).toBe('/tmp/run-1.jsonl');
    });

    it('returns null for unknown run id', () => {
      const store = new SQLiteRunStore(':memory:');
      expect(store.getLogPath('does-not-exist')).toBeNull();
    });
  });

  describe('parent_run_id', () => {
    it('persists and retrieves parent_run_id', () => {
      const run: PipelineRun = {
        id: 'child-123',
        pipeline_name: 'child-pipe',
        status: 'success',
        started_at: new Date().toISOString(),
        stages: [],
        parent_run_id: 'parent-456',
      };
      const store = new SQLiteRunStore(':memory:');
      store.savePipelineRun(run);
      const retrieved = store.getPipelineRun('child-123');
      expect(retrieved?.parent_run_id).toBe('parent-456');
    });
  });

  describe('orphaned-run reconciliation (STU-625)', () => {
    const orphan = (overrides?: Partial<PipelineRun>): PipelineRun =>
      makeRun({ status: 'running', pid: DEAD_PID, hostname: os.hostname(), ...overrides });

    it('reports an orphaned running row as interrupted', () => {
      const store = new SQLiteRunStore(':memory:');
      store.savePipelineRun(orphan());
      expect(store.getPipelineRun('run-1')?.status).toBe('interrupted');
    });

    it('persists the reconciliation so a status filter no longer sees it as running', () => {
      const store = new SQLiteRunStore(':memory:');
      store.savePipelineRun(orphan());
      store.getPipelineRun('run-1');
      expect(store.listPipelineRuns({ status: 'running' })).toHaveLength(0);
      expect(store.listPipelineRuns({ status: 'interrupted' })).toHaveLength(1);
    });

    it('reconciles via listPipelineRuns and getLatestRun too', () => {
      const store = new SQLiteRunStore(':memory:');
      store.savePipelineRun(orphan());
      expect(store.listPipelineRuns()[0].status).toBe('interrupted');
      expect(store.getLatestRun()?.status).toBe('interrupted');
    });

    it('closes out orphaned child rows the same way', () => {
      const store = new SQLiteRunStore(':memory:');
      store.savePipelineRun(orphan({ id: 'child-1', parent_run_id: 'run-1' }));
      expect(store.getPipelineRun('child-1')?.status).toBe('interrupted');
    });

    it('leaves a live running row alone', () => {
      const store = new SQLiteRunStore(':memory:');
      store.savePipelineRun(orphan({ pid: process.pid }));
      expect(store.getPipelineRun('run-1')?.status).toBe('running');
    });

    it('does not judge a run from another host', () => {
      const store = new SQLiteRunStore(':memory:');
      store.savePipelineRun(orphan({ hostname: 'some-other-host' }));
      expect(store.getPipelineRun('run-1')?.status).toBe('running');
    });

    it('leaves a running row with no owner info alone', () => {
      const store = new SQLiteRunStore(':memory:');
      store.savePipelineRun(makeRun({ status: 'running' }));
      expect(store.getPipelineRun('run-1')?.status).toBe('running');
    });

    it('never touches a terminal row', () => {
      const store = new SQLiteRunStore(':memory:');
      store.savePipelineRun(makeRun({ status: 'success', pid: DEAD_PID, hostname: os.hostname() }));
      expect(store.getPipelineRun('run-1')?.status).toBe('success');
    });

    it('applies to the in-memory store as well', () => {
      const store = new InMemoryRunStore();
      store.savePipelineRun(orphan());
      expect(store.getPipelineRun('run-1')?.status).toBe('interrupted');
    });
  });
});

const TEST_PG_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_PG_URL)('PgRunStore', () => {
  let store: PgRunStore;

  beforeEach(async () => {
    store = new PgRunStore(TEST_PG_URL!);
    await store.dangerouslyTruncateForTests();
  });

  afterEach(async () => {
    await store.close();
  });

  it('saves and retrieves a pipeline run', async () => {
    const run = makePgRun('pg-run-1');
    await store.savePipelineRun(run);
    const found = await store.getPipelineRun('pg-run-1');
    expect(found).toMatchObject({ id: 'pg-run-1', status: 'success' });
  });

  it('returns null for unknown id', async () => {
    const found = await store.getPipelineRun('doesnt-exist');
    expect(found).toBeNull();
  });

  it('updates an existing run (upsert)', async () => {
    const run = makePgRun('pg-run-2');
    await store.savePipelineRun(run);
    await store.savePipelineRun({ ...run, status: 'failed' });
    const found = await store.getPipelineRun('pg-run-2');
    expect(found?.status).toBe('failed');
  });

  it('lists runs with status filter', async () => {
    await store.savePipelineRun(makePgRun('pg-1', 'success'));
    await store.savePipelineRun(makePgRun('pg-2', 'failed'));
    const successes = await store.listPipelineRuns({ status: 'success' });
    expect(successes).toHaveLength(1);
    expect(successes[0].id).toBe('pg-1');
  });

  it('lists runs with limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.savePipelineRun(makePgRun(`pg-limit-${i}`));
    }
    const runs = await store.listPipelineRuns({ limit: 3 });
    expect(runs).toHaveLength(3);
  });

  it('getLatestRun returns most recent', async () => {
    await store.savePipelineRun(makePgRun('pg-old', 'success', '2024-01-01T00:00:00Z'));
    await store.savePipelineRun(makePgRun('pg-new', 'success', '2024-06-01T00:00:00Z'));
    const latest = await store.getLatestRun();
    expect(latest?.id).toBe('pg-new');
  });

  it('getLatestRun filters by pipeline name', async () => {
    await store.savePipelineRun(makePgRun('pg-a', 'success', undefined, 'pipeline-a'));
    await store.savePipelineRun(makePgRun('pg-b', 'success', undefined, 'pipeline-b'));
    const latest = await store.getLatestRun('pipeline-a');
    expect(latest?.id).toBe('pg-a');
  });

  it('saves and retrieves log path', async () => {
    await store.savePipelineRun(makePgRun('pg-log-1'));
    await store.saveLogPath('pg-log-1', '/tmp/test.jsonl');
    const path = await store.getLogPath('pg-log-1');
    expect(path).toBe('/tmp/test.jsonl');
  });

  it('returns null log path for unknown run', async () => {
    const path = await store.getLogPath('no-such-run');
    expect(path).toBeNull();
  });
});

function makePgRun(
  id: string,
  status: string = 'success',
  startedAt: string = new Date().toISOString(),
  pipelineName: string = 'test-pipeline'
) {
  return {
    id,
    pipeline_name: pipelineName,
    status,
    started_at: startedAt,
    stages: [],
  } as PipelineRun;
}
