import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getRunFromJsonl } from '../../src/commands/status.js';

/** Build a JSONL log the way mergeEvents writes one. */
function jsonl(records: Record<string, unknown>[]): string {
  return records.map((r) => JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', ...r })).join('\n') + '\n';
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'studio-status-jsonl-'));
  mkdirSync(resolve(dir, '.studio/runs'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeLog(name: string, content: string): void {
  writeFileSync(resolve(dir, '.studio/runs', name), content);
}

describe('getRunFromJsonl — call-chained run (STU-680)', () => {
  it('reconstructs the parent stages, ignoring the nested child events', async () => {
    const parent = 'abcd1234';
    writeLog(
      `2026-01-01T00h00m-wiki-full-${parent}.jsonl`,
      jsonl([
        { event: 'pipeline_start', run_id: parent, pipeline: 'wiki-full' },
        { event: 'stage_start', stage: 'discover', stage_index: 0, total_stages: 2, run_id: parent },
        // Child run spawned by the `call` stage — same file, tagged by depth.
        { event: 'pipeline_start', run_id: 'child001', pipeline: 'discover-relationships', depth: 1 },
        { event: 'stage_complete', stage: 'child-stage', status: 'success', attempts: 1, duration_ms: 500, run_id: parent, depth: 1 },
        { event: 'pipeline_complete', run_id: 'child001', status: 'success', depth: 1 },
        { event: 'stage_complete', stage: 'discover', status: 'success', attempts: 1, duration_ms: 1000, run_id: parent },
        { event: 'stage_complete', stage: 'generate', status: 'success', attempts: 2, duration_ms: 2000, run_id: parent },
        { event: 'pipeline_complete', run_id: parent, status: 'success' },
      ])
    );

    const run = await getRunFromJsonl(parent, dir);

    expect(run).not.toBeNull();
    expect(run!.pipeline_name).toBe('wiki-full');
    expect(run!.status).toBe('success');
    expect(run!.stages.map((s) => s.stage_name)).toEqual(['discover', 'generate']);
  });

  it('still parses a flat run with no nested events', async () => {
    const runId = 'ffff0000';
    writeLog(
      `2026-01-01T00h00m-simple-${runId}.jsonl`,
      jsonl([
        { event: 'pipeline_start', run_id: runId, pipeline: 'simple' },
        { event: 'stage_complete', stage: 'only', status: 'success', attempts: 1, duration_ms: 100, run_id: runId },
        { event: 'pipeline_complete', run_id: runId, status: 'success' },
      ])
    );

    const run = await getRunFromJsonl(runId, dir);

    expect(run!.stages).toHaveLength(1);
    expect(run!.stages[0].stage_name).toBe('only');
  });
});

describe('getRunFromJsonl — token usage (STU-750)', () => {
  it('reads the recorded usage onto each stage', async () => {
    const runId = 'aa11bb22';
    writeLog(
      `2026-01-01T00h00m-costly-${runId}.jsonl`,
      jsonl([
        { event: 'pipeline_start', run_id: runId, pipeline: 'costly' },
        {
          event: 'stage_complete', stage: 'generate', status: 'success', attempts: 1,
          duration_ms: 1000, run_id: runId,
          tokens: {
            prompt_tokens: 4, completion_tokens: 437, total_tokens: 34953,
            cached_input_tokens: 21000, cache_creation_tokens: 13512,
            by_model: { 'claude-sonnet-4-5': { prompt_tokens: 4, completion_tokens: 437, total_tokens: 34953 } },
          },
        },
        { event: 'pipeline_complete', run_id: runId, status: 'success' },
      ])
    );

    const run = await getRunFromJsonl(runId, dir);

    expect(run!.stages[0].token_usage).toEqual({
      prompt_tokens: 4, completion_tokens: 437, total_tokens: 34953,
      cached_input_tokens: 21000, cache_creation_tokens: 13512,
      by_model: { 'claude-sonnet-4-5': { prompt_tokens: 4, completion_tokens: 437, total_tokens: 34953 } },
    });
  });

  it('still reads runs recorded before the shape changed', async () => {
    const runId = 'cc33dd44';
    writeLog(
      `2026-01-01T00h00m-legacy-${runId}.jsonl`,
      jsonl([
        { event: 'pipeline_start', run_id: runId, pipeline: 'legacy' },
        {
          event: 'stage_complete', stage: 'analysis', status: 'success', attempts: 1,
          duration_ms: 500, run_id: runId,
          tokens: { prompt: 100, completion: 50, total: 150 },
        },
        { event: 'pipeline_complete', run_id: runId, status: 'success' },
      ])
    );

    const run = await getRunFromJsonl(runId, dir);

    expect(run!.stages[0].token_usage).toEqual({
      prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
    });
  });

  it('leaves token_usage off a stage that recorded none', async () => {
    const runId = 'ee55ff66';
    writeLog(
      `2026-01-01T00h00m-quiet-${runId}.jsonl`,
      jsonl([
        { event: 'pipeline_start', run_id: runId, pipeline: 'quiet' },
        { event: 'stage_complete', stage: 'analysis', status: 'success', attempts: 1, duration_ms: 500, run_id: runId },
        { event: 'pipeline_complete', run_id: runId, status: 'success' },
      ])
    );

    const run = await getRunFromJsonl(runId, dir);

    expect(run!.stages[0].token_usage).toBeUndefined();
  });
});
