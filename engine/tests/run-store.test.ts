import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRunStore } from '../src/state/run-store.js';
import type { PipelineRun } from '@studio/contracts';

function makePipelineRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    pipeline_name: 'test-pipeline',
    status: 'success',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    stages: [],
    ...overrides,
  } as PipelineRun;
}

describe('InMemoryRunStore', () => {
  let store: InMemoryRunStore;

  beforeEach(() => {
    store = new InMemoryRunStore();
  });

  it('saves and retrieves a pipeline run', () => {
    const run = makePipelineRun({ id: 'run-1' });
    store.savePipelineRun(run);

    const retrieved = store.getPipelineRun('run-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe('run-1');
    expect(retrieved!.pipeline_name).toBe('test-pipeline');
  });

  it('returns null for non-existent run', () => {
    expect(store.getPipelineRun('nonexistent')).toBeNull();
  });

  it('returns a clone (not the original reference)', () => {
    const run = makePipelineRun({ id: 'run-clone' });
    store.savePipelineRun(run);

    const retrieved = store.getPipelineRun('run-clone');
    expect(retrieved).not.toBe(run);
  });

  it('listPipelineRuns returns all runs', () => {
    store.savePipelineRun(makePipelineRun({ id: 'r1', started_at: '2024-01-01T00:00:00Z' }));
    store.savePipelineRun(makePipelineRun({ id: 'r2', started_at: '2024-01-02T00:00:00Z' }));
    store.savePipelineRun(makePipelineRun({ id: 'r3', started_at: '2024-01-03T00:00:00Z' }));

    const runs = store.listPipelineRuns();
    expect(runs).toHaveLength(3);
  });

  it('listPipelineRuns sorts by started_at descending', () => {
    store.savePipelineRun(makePipelineRun({ id: 'r1', started_at: '2024-01-01T00:00:00Z' }));
    store.savePipelineRun(makePipelineRun({ id: 'r3', started_at: '2024-01-03T00:00:00Z' }));
    store.savePipelineRun(makePipelineRun({ id: 'r2', started_at: '2024-01-02T00:00:00Z' }));

    const runs = store.listPipelineRuns();
    expect(runs[0].id).toBe('r3');
    expect(runs[1].id).toBe('r2');
    expect(runs[2].id).toBe('r1');
  });

  it('listPipelineRuns respects limit', () => {
    store.savePipelineRun(makePipelineRun({ id: 'r1', started_at: '2024-01-01T00:00:00Z' }));
    store.savePipelineRun(makePipelineRun({ id: 'r2', started_at: '2024-01-02T00:00:00Z' }));
    store.savePipelineRun(makePipelineRun({ id: 'r3', started_at: '2024-01-03T00:00:00Z' }));

    const runs = store.listPipelineRuns({ limit: 2 });
    expect(runs).toHaveLength(2);
  });

  it('listPipelineRuns filters by status', () => {
    store.savePipelineRun(makePipelineRun({ id: 'r1', status: 'success' }));
    store.savePipelineRun(makePipelineRun({ id: 'r2', status: 'failed' }));
    store.savePipelineRun(makePipelineRun({ id: 'r3', status: 'success' }));

    const runs = store.listPipelineRuns({ status: 'failed' });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe('r2');
  });

  it('getLatestRun returns the most recent run', () => {
    store.savePipelineRun(makePipelineRun({ id: 'r1', started_at: '2024-01-01T00:00:00Z' }));
    store.savePipelineRun(makePipelineRun({ id: 'r2', started_at: '2024-01-03T00:00:00Z' }));
    store.savePipelineRun(makePipelineRun({ id: 'r3', started_at: '2024-01-02T00:00:00Z' }));

    const latest = store.getLatestRun();
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe('r2');
  });

  it('getLatestRun filters by pipeline name', () => {
    store.savePipelineRun(makePipelineRun({
      id: 'r1',
      pipeline_name: 'feature-builder',
      started_at: '2024-01-01T00:00:00Z',
    }));
    store.savePipelineRun(makePipelineRun({
      id: 'r2',
      pipeline_name: 'other-pipeline',
      started_at: '2024-01-03T00:00:00Z',
    }));

    const latest = store.getLatestRun('feature-builder');
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe('r1');
  });

  it('getLatestRun returns null when empty', () => {
    expect(store.getLatestRun()).toBeNull();
  });

  it('overwrites existing run on save with same id', () => {
    const run = makePipelineRun({ id: 'r1', status: 'running' });
    store.savePipelineRun(run);

    const updated = { ...run, status: 'success' as const, completed_at: new Date().toISOString() };
    store.savePipelineRun(updated);

    const retrieved = store.getPipelineRun('r1');
    expect(retrieved!.status).toBe('success');
  });

  describe('log path', () => {
    it('returns null for unknown run', () => {
      expect(store.getLogPath('nonexistent')).toBeNull();
    });

    it('saves and retrieves a log path', () => {
      store.saveLogPath('run-1', '/tmp/.studio/runs/log.jsonl');
      expect(store.getLogPath('run-1')).toBe('/tmp/.studio/runs/log.jsonl');
    });

    it('overwrites existing log path', () => {
      store.saveLogPath('run-1', '/tmp/old.jsonl');
      store.saveLogPath('run-1', '/tmp/new.jsonl');
      expect(store.getLogPath('run-1')).toBe('/tmp/new.jsonl');
    });
  });
});
