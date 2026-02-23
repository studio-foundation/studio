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

describe('replay integration — full JSONL file', () => {
  it('maps a complete pipeline run through all events without errors', () => {
    const jsonlLines = [
      { event: 'pipeline_start', pipeline: 'test-pipe', run_id: 'aabb1122', ts: '2026-02-22T14:00:00Z' },
      { event: 'stage_start', stage: 'analysis', stage_index: 0, total_stages: 2, ts: '2026-02-22T14:00:01Z' },
      { event: 'tool_call_start', tool: 'repo_manager-read_file', params: { path: 'README.md' }, ts: '2026-02-22T14:00:02Z' },
      { event: 'tool_call_complete', tool: 'repo_manager-read_file', result: { content: '# Hello' }, duration_ms: 100, ts: '2026-02-22T14:00:02Z' },
      { event: 'stage_complete', stage: 'analysis', stage_index: 0, total_stages: 2, status: 'success', attempts: 1, duration_ms: 2000, tokens: { prompt: 500, completion: 200, total: 700 }, output: { summary: 'analyzed' }, ts: '2026-02-22T14:00:03Z' },
      { event: 'stage_start', stage: 'code-generation', stage_index: 1, total_stages: 2, ts: '2026-02-22T14:00:04Z' },
      { event: 'stage_retry', stage: 'code-generation', attempt: 2, max_attempts: 3, failures: ['missing field'], ts: '2026-02-22T14:00:05Z' },
      { event: 'stage_complete', stage: 'code-generation', stage_index: 1, total_stages: 2, status: 'success', attempts: 2, duration_ms: 4000, tokens: { prompt: 800, completion: 400, total: 1200 }, output: { summary: 'generated' }, ts: '2026-02-22T14:00:08Z' },
      { event: 'pipeline_complete', pipeline_name: 'test-pipe', run_id: 'aabb1122', status: 'success', duration_ms: 8000, total_tokens: 1900, total_tool_calls: 1, ts: '2026-02-22T14:00:08Z' },
    ];

    const mapped = jsonlLines.map((line) => mapJsonlLineToEvent(line));
    expect(mapped.every((m) => m !== null)).toBe(true);
    expect(mapped.map((m) => m!.handler)).toEqual([
      'onPipelineStart',
      'onStageStart',
      'onToolCallStart',
      'onToolCallComplete',
      'onStageComplete',
      'onStageStart',
      'onTaskRetry',
      'onStageComplete',
      'onPipelineComplete',
    ]);
  });

  it('maps a rejected group run', () => {
    const jsonlLines = [
      { event: 'pipeline_start', pipeline: 'test-pipe', run_id: 'ccdd3344', ts: '2026-02-22T14:00:00Z' },
      { event: 'group_start', group: 'impl-review', max_iterations: 3, ts: '2026-02-22T14:00:01Z' },
      { event: 'group_iteration', group: 'impl-review', iteration: 1, max_iterations: 3, ts: '2026-02-22T14:00:02Z' },
      { event: 'stage_start', stage: 'code-gen', stage_index: 0, total_stages: 2, ts: '2026-02-22T14:00:03Z' },
      { event: 'stage_complete', stage: 'code-gen', stage_index: 0, total_stages: 2, status: 'success', attempts: 1, duration_ms: 2000, ts: '2026-02-22T14:00:05Z' },
      { event: 'stage_start', stage: 'qa-review', stage_index: 1, total_stages: 2, ts: '2026-02-22T14:00:06Z' },
      { event: 'stage_complete', stage: 'qa-review', stage_index: 1, total_stages: 2, status: 'rejected', attempts: 1, duration_ms: 1500, rejection_reason: 'code incomplete', rejection_details: ['missing error handling'], ts: '2026-02-22T14:00:07Z' },
      { event: 'group_feedback', group: 'impl-review', iteration: 1, rejection_reason: 'code incomplete', rejection_details: ['missing error handling'], ts: '2026-02-22T14:00:07Z' },
      { event: 'group_complete', group: 'impl-review', iterations: 1, status: 'rejected', ts: '2026-02-22T14:00:07Z' },
      { event: 'pipeline_complete', pipeline_name: 'test-pipe', run_id: 'ccdd3344', status: 'rejected', duration_ms: 7000, total_tokens: 2000, total_tool_calls: 0, ts: '2026-02-22T14:00:07Z' },
    ];

    const mapped = jsonlLines.map((line) => mapJsonlLineToEvent(line));
    expect(mapped.every((m) => m !== null)).toBe(true);

    const stageComplete = mapped.find((m) => m!.handler === 'onStageComplete' && m!.payload.status === 'rejected');
    expect(stageComplete!.payload.rejection_reason).toBe('code incomplete');
    expect(stageComplete!.payload.rejection_details).toEqual(['missing error handling']);
  });

  it('skips corrupt JSONL lines gracefully', () => {
    const validLine = { event: 'pipeline_start', pipeline: 'test', run_id: 'xxxx' };
    const mapped = mapJsonlLineToEvent(validLine);
    expect(mapped).not.toBeNull();

    const unknownLine = { event: 'totally_unknown', data: 123 };
    expect(mapJsonlLineToEvent(unknownLine)).toBeNull();
  });
});
