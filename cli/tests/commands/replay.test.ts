import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { findJsonlFile, mapJsonlLineToEvent } from '../../src/commands/replay.js';

const TMP = resolve('/tmp', '.studio-replay-test');
const RUNS_DIR = resolve(TMP, '.studio/runs');

beforeEach(() => {
  mkdirSync(RUNS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('findJsonlFile', () => {
  it('finds a JSONL file matching full 8-char run-id', () => {
    const filename = '2026-02-22T14h35m-feature-builder-abc12345.jsonl';
    writeFileSync(resolve(RUNS_DIR, filename), '');
    const result = findJsonlFile(RUNS_DIR, 'abc12345');
    expect(result).toBe(resolve(RUNS_DIR, filename));
  });

  it('finds a JSONL file matching partial run-id (4 chars)', () => {
    const filename = '2026-02-22T14h35m-feature-builder-abc12345.jsonl';
    writeFileSync(resolve(RUNS_DIR, filename), '');
    const result = findJsonlFile(RUNS_DIR, 'abc1');
    expect(result).toBe(resolve(RUNS_DIR, filename));
  });

  it('throws if no matching file found', () => {
    writeFileSync(resolve(RUNS_DIR, '2026-02-22T14h35m-pipe-zzz99999.jsonl'), '');
    expect(() => findJsonlFile(RUNS_DIR, 'abc1')).toThrow(/No run log found/);
  });

  it('throws if multiple files match an ambiguous prefix', () => {
    writeFileSync(resolve(RUNS_DIR, '2026-02-22T14h35m-pipe1-abc12345.jsonl'), '');
    writeFileSync(resolve(RUNS_DIR, '2026-02-22T15h00m-pipe2-abc12399.jsonl'), '');
    expect(() => findJsonlFile(RUNS_DIR, 'abc12')).toThrow(/Multiple/);
  });

  it('strips dashes from UUID-style run-id before matching', () => {
    const filename = '2026-02-22T14h35m-feature-builder-abc12345.jsonl';
    writeFileSync(resolve(RUNS_DIR, filename), '');
    const result = findJsonlFile(RUNS_DIR, 'abc1-2345');
    expect(result).toBe(resolve(RUNS_DIR, filename));
  });
});

describe('mapJsonlLineToEvent', () => {
  it('maps pipeline_start', () => {
    const line = { event: 'pipeline_start', pipeline: 'feature-builder', run_id: 'abc12345' };
    const result = mapJsonlLineToEvent(line);
    expect(result).toEqual({
      handler: 'onPipelineStart',
      payload: { pipeline_name: 'feature-builder', run_id: 'abc12345' },
    });
  });

  it('maps pipeline_complete', () => {
    const line = {
      event: 'pipeline_complete', pipeline_name: 'feature-builder', run_id: 'abc12345',
      status: 'success', duration_ms: 5000, total_tokens: 1000, total_tool_calls: 3,
    };
    const result = mapJsonlLineToEvent(line);
    expect(result).toEqual({
      handler: 'onPipelineComplete',
      payload: {
        pipeline_name: 'feature-builder', run_id: 'abc12345',
        status: 'success', duration_ms: 5000, total_tokens: 1000, total_tool_calls: 3,
      },
    });
  });

  it('maps stage_start (stage → stage_name)', () => {
    const line = { event: 'stage_start', stage: 'code-generation', stage_index: 0, total_stages: 3 };
    const result = mapJsonlLineToEvent(line);
    expect(result).toEqual({
      handler: 'onStageStart',
      payload: { stage_name: 'code-generation', stage_index: 0, total_stages: 3 },
    });
  });

  it('maps stage_complete with token remapping', () => {
    const line = {
      event: 'stage_complete', stage: 'code-generation', status: 'success',
      stage_index: 0, total_stages: 3,
      attempts: 1, duration_ms: 2000,
      tokens: { prompt: 500, completion: 200, total: 700 },
      tool_calls: [{ name: 'repo_manager-write_file', arguments_summary: 'path=src/foo.ts' }],
      output: { summary: 'done' },
    };
    const result = mapJsonlLineToEvent(line);
    expect(result?.payload).toMatchObject({
      stage_name: 'code-generation',
      token_usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 },
    });
  });

  it('maps stage_retry', () => {
    const line = {
      event: 'stage_retry', stage: 'code-generation', attempt: 2, max_attempts: 3,
      failures: ['missing field: summary'], tool_calls_count: 1,
    };
    const result = mapJsonlLineToEvent(line);
    expect(result).toEqual({
      handler: 'onTaskRetry',
      payload: {
        stage: 'code-generation', attempt: 2, max_attempts: 3,
        failures: ['missing field: summary'], tool_calls_count: 1,
      },
    });
  });

  it('maps group events (group → group_name)', () => {
    const line = { event: 'group_start', group: 'impl-review', max_iterations: 3 };
    const result = mapJsonlLineToEvent(line);
    expect(result).toEqual({
      handler: 'onGroupStart',
      payload: { group_name: 'impl-review', max_iterations: 3 },
    });
  });

  it('maps tool_call_start', () => {
    const line = { event: 'tool_call_start', tool: 'repo_manager-write_file', params: { path: 'src/foo.ts' } };
    const result = mapJsonlLineToEvent(line);
    expect(result).toEqual({
      handler: 'onToolCallStart',
      payload: { tool: 'repo_manager-write_file', params: { path: 'src/foo.ts' }, timestamp: 0 },
    });
  });

  it('maps tool_call_complete', () => {
    const line = { event: 'tool_call_complete', tool: 'repo_manager-write_file', result: { written: true }, duration_ms: 50 };
    const result = mapJsonlLineToEvent(line);
    expect(result).toEqual({
      handler: 'onToolCallComplete',
      payload: { tool: 'repo_manager-write_file', result: { written: true }, duration_ms: 50, timestamp: 0 },
    });
  });

  it('returns null for unknown event types', () => {
    const line = { event: 'unknown_thing', data: 123 };
    const result = mapJsonlLineToEvent(line);
    expect(result).toBeNull();
  });
});
