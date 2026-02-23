import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRunLogger } from '../src/run-logger.js';

const TMP = resolve('/tmp', '.studio-run-logger-test');

afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe('RunLogger — close flushes to disk', () => {
  it('close() returns a Promise', () => {
    const logger = createRunLogger(TMP);
    logger.start('aaaa1111-bbbb-cccc-dddd-eeeeeeee0001', 'test-pipe');
    const result = logger.close();
    // close() must return a thenable so callers can await it
    expect(result).toBeInstanceOf(Promise);
  });

  it('all entries are on disk after close() resolves', async () => {
    const logger = createRunLogger(TMP);
    logger.start('aaaa1111-bbbb-cccc-dddd-eeeeeeee0002', 'flush-test');

    logger.log({ event: 'pipeline_start', pipeline: 'flush-test' });
    logger.log({ event: 'stage_start', stage: 'analysis' });
    logger.log({ event: 'stage_complete', stage: 'analysis', status: 'failed' });
    logger.log({ event: 'pipeline_complete', status: 'failed', duration_ms: 1234 });

    await logger.close();

    const content = readFileSync(logger.getLogPath(), 'utf-8');
    const lines = content.trim().split('\n');
    const events = lines.map(l => JSON.parse(l).event);

    expect(events).toEqual([
      'pipeline_start',
      'stage_start',
      'stage_complete',
      'pipeline_complete',
    ]);
  });

  it('pipeline_complete is present after close() on a rejected run', async () => {
    const logger = createRunLogger(TMP);
    logger.start('aaaa1111-bbbb-cccc-dddd-eeeeeeee0003', 'reject-test');

    logger.log({ event: 'pipeline_start', pipeline: 'reject-test' });
    logger.log({ event: 'group_start', group: 'impl-review' });
    logger.log({ event: 'group_complete', group: 'impl-review', status: 'rejected' });
    logger.log({ event: 'pipeline_complete', status: 'rejected', duration_ms: 5678 });

    await logger.close();

    const content = readFileSync(logger.getLogPath(), 'utf-8');
    const lines = content.trim().split('\n');
    const lastEvent = JSON.parse(lines[lines.length - 1]);

    expect(lastEvent.event).toBe('pipeline_complete');
    expect(lastEvent.status).toBe('rejected');
  });
});
