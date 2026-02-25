import { describe, it, expect } from 'vitest';
import { SQLiteRunStore } from './run-store.js';
import type { PipelineRun } from '@studio/contracts';

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
});
