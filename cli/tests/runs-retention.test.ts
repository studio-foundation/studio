import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { SQLiteRunStore } from '@studio-foundation/engine';
import { pruneRuns, parseDuration } from '../src/runs-retention.js';

const STUDIO = resolve('/tmp', '.studio-runs-retention-test');
const RUNS = join(STUDIO, 'runs');
const ANON = join(RUNS, 'anonymization');
const DAY = 24 * 60 * 60 * 1000;

function addRun(shortId: string, status: string, ageDays: number, withKeymap = true): string {
  const name = `2026-01-01T10h00m-demo-${shortId}.jsonl`;
  const file = join(RUNS, name);
  writeFileSync(
    file,
    `{"event":"pipeline_start","run_id":"${shortId}"}\n{"event":"pipeline_complete","status":"${status}","run_id":"${shortId}"}\n`,
  );
  const when = new Date(Date.now() - ageDays * DAY);
  utimesSync(file, when, when);
  if (withKeymap) writeFileSync(join(ANON, `${shortId}0000-aaaa-bbbb-cccc-dddddddddddd.keymap.json`), '{}');
  return name;
}

const runIdOf = (shortId: string) => `${shortId}0000-aaaa-bbbb-cccc-dddddddddddd`;

function rowIds(): string[] {
  const store = new SQLiteRunStore(join(RUNS, 'runs.db'));
  try {
    return store.listPipelineRuns().map((run) => run.id).sort();
  } finally {
    store.close();
  }
}

const keymapOf = (shortId: string) => join(ANON, `${shortId}0000-aaaa-bbbb-cccc-dddddddddddd.keymap.json`);

describe('pruneRuns', () => {
  beforeEach(() => {
    rmSync(STUDIO, { recursive: true, force: true });
    mkdirSync(ANON, { recursive: true });
    addRun('aaaaaaaa', 'success', 60);
    addRun('bbbbbbbb', 'failed', 60);
    addRun('cccccccc', 'success', 2);
    const store = new SQLiteRunStore(join(RUNS, 'runs.db'));
    for (const shortId of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']) {
      store.savePipelineRun({
        id: runIdOf(shortId),
        pipeline_name: 'demo',
        status: 'success',
        started_at: '2026-01-01T10:00:00.000Z',
        completed_at: '2026-01-01T10:01:00.000Z',
        stages: [],
      });
    }
    store.close();
  });

  it('--max-age removes only old runs and their keymaps', async () => {
    const result = await pruneRuns(STUDIO, { maxAgeMs: 30 * DAY });
    expect(result.runs).toHaveLength(2);
    expect(result.keymaps).toBe(2);
    expect(existsSync(join(RUNS, '2026-01-01T10h00m-demo-aaaaaaaa.jsonl'))).toBe(false);
    expect(existsSync(keymapOf('aaaaaaaa'))).toBe(false);
    expect(existsSync(join(RUNS, '2026-01-01T10h00m-demo-cccccccc.jsonl'))).toBe(true);
    expect(existsSync(keymapOf('cccccccc'))).toBe(true);
  });

  it('--max-age removes the run-store rows of the removed logs', async () => {
    const result = await pruneRuns(STUDIO, { maxAgeMs: 30 * DAY });
    expect(result.rows).toBe(2);
    expect(rowIds()).toEqual([runIdOf('cccccccc')]);
  });

  it('leaves the run-store row of a protected run', async () => {
    await pruneRuns(STUDIO, { maxAgeMs: 30 * DAY, keepStatus: ['failed'] });
    expect(rowIds()).toEqual([runIdOf('bbbbbbbb'), runIdOf('cccccccc')]);
  });

  it('does not create a runs.db when the project has none', async () => {
    rmSync(join(RUNS, 'runs.db'));
    const result = await pruneRuns(STUDIO, { maxAgeMs: 30 * DAY });
    expect(result.rows).toBe(0);
    expect(existsSync(join(RUNS, 'runs.db'))).toBe(false);
  });

  it('--keep-status protects matching runs', async () => {
    await pruneRuns(STUDIO, { maxAgeMs: 30 * DAY, keepStatus: ['failed'] });
    expect(existsSync(join(RUNS, '2026-01-01T10h00m-demo-bbbbbbbb.jsonl'))).toBe(true);
    expect(existsSync(keymapOf('bbbbbbbb'))).toBe(true);
    expect(existsSync(join(RUNS, '2026-01-01T10h00m-demo-aaaaaaaa.jsonl'))).toBe(false);
  });

  it('--keep-last alone removes everything beyond the newest N', async () => {
    const result = await pruneRuns(STUDIO, { keepLast: 1 });
    expect(result.runs).toHaveLength(2);
    expect(existsSync(join(RUNS, '2026-01-01T10h00m-demo-cccccccc.jsonl'))).toBe(true);
  });

  it('--dry-run lists without deleting', async () => {
    const result = await pruneRuns(STUDIO, { maxAgeMs: 30 * DAY, dryRun: true });
    expect(result.runs).toHaveLength(2);
    expect(result.keymaps).toBe(2);
    expect(existsSync(join(RUNS, '2026-01-01T10h00m-demo-aaaaaaaa.jsonl'))).toBe(true);
    expect(existsSync(keymapOf('aaaaaaaa'))).toBe(true);
    expect(result.rows).toBe(2);
    expect(rowIds()).toHaveLength(3);
  });

  it('refuses to run with no criterion', async () => {
    await expect(pruneRuns(STUDIO, {})).rejects.toThrow(/keep-last/);
  });

  it('parses durations', () => {
    expect(parseDuration('30d')).toBe(30 * DAY);
    expect(parseDuration('12h')).toBe(DAY / 2);
    expect(() => parseDuration('soon')).toThrow();
  });
});
