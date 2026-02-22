import { describe, it, expect, vi } from 'vitest';
import type { EngineEvents } from '@studio/engine';

interface LogEntry {
  ts: string;
  event: string;
  [key: string]: unknown;
}

function createCapturingLogger() {
  const entries: LogEntry[] = [];
  return {
    logger: {
      start: vi.fn(),
      log: vi.fn((payload: Record<string, unknown>) => {
        entries.push({ ts: new Date().toISOString(), ...payload } as LogEntry);
      }),
      close: vi.fn(),
      getLogPath: () => '/tmp/test.jsonl',
    },
    entries,
  };
}

describe('mergeEvents — pipeline_start', () => {
  it('logs full input object (no truncation)', async () => {
    const { mergeEvents } = await import('../src/commands/run.js');
    const { logger, entries } = createCapturingLogger();
    const noopEvents: EngineEvents = {};

    const largeInput = {
      brief_summary: 'A'.repeat(500),
      nested: { deep: { value: 'B'.repeat(300) } },
    };

    const events = mergeEvents(noopEvents, logger, 'test-pipeline', largeInput);
    events.onPipelineStart!({ pipeline_name: 'test-pipeline', run_id: 'abc12345-def6-7890' });

    expect(logger.start).toHaveBeenCalledWith('abc12345-def6-7890', 'test-pipeline');
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.event).toBe('pipeline_start');
    expect(entry.input).toEqual(largeInput);
    // input_summary should not exist anymore
    expect(entry).not.toHaveProperty('input_summary');
  });

  it('logs full input string (no truncation)', async () => {
    const { mergeEvents } = await import('../src/commands/run.js');
    const { logger, entries } = createCapturingLogger();
    const noopEvents: EngineEvents = {};
    const largeString = 'X'.repeat(1000);

    const events = mergeEvents(noopEvents, logger, 'pipe', largeString);
    events.onPipelineStart!({ pipeline_name: 'pipe', run_id: 'run-id-12345678' });

    const entry = entries[0];
    expect(entry.input).toBe(largeString);
  });
});

describe('mergeEvents — pipeline_complete', () => {
  it('logs pipeline_name from event', async () => {
    const { mergeEvents } = await import('../src/commands/run.js');
    const { logger, entries } = createCapturingLogger();
    const noopEvents: EngineEvents = {};

    const events = mergeEvents(noopEvents, logger, 'feature-builder', 'test input');
    // Must call onPipelineStart first to initialize logger
    events.onPipelineStart!({ pipeline_name: 'feature-builder', run_id: 'run-12345678' });
    events.onPipelineComplete!({
      pipeline_name: 'feature-builder',
      run_id: 'run-12345678',
      status: 'success',
      duration_ms: 12345,
      total_tokens: 5000,
      total_tool_calls: 7,
    });

    const entry = entries.find(e => e.event === 'pipeline_complete')!;
    expect(entry.pipeline_name).toBe('feature-builder');
    expect(entry.status).toBe('success');
    expect(entry.duration_ms).toBe(12345);
    expect(entry.total_tokens).toBe(5000);
    expect(entry.total_tool_calls).toBe(7);
  });
});

describe('mergeEvents — stage_complete', () => {
  it('logs full output object (not truncated summary)', async () => {
    const { mergeEvents } = await import('../src/commands/run.js');
    const { logger, entries } = createCapturingLogger();
    const noopEvents: EngineEvents = {};

    const events = mergeEvents(noopEvents, logger, 'pipe', 'input');
    events.onPipelineStart!({ pipeline_name: 'pipe', run_id: 'run-12345678' });

    const largeOutput = {
      summary: 'A'.repeat(500),
      files_changed: ['src/a.ts', 'src/b.ts'],
      details: { nested: 'B'.repeat(300) },
    };

    events.onStageComplete!({
      stage_name: 'code-generation',
      stage_index: 0,
      total_stages: 3,
      status: 'success',
      attempts: 1,
      duration_ms: 5000,
      output: largeOutput,
      output_summary: '3 fields: summary, files_changed, details',
      tool_calls: [
        { name: 'repo_manager-write_file', arguments_summary: 'src/a.ts' },
        { name: 'repo_manager-write_file', arguments_summary: 'src/b.ts' },
      ],
      token_usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    });

    const entry = entries.find(e => e.event === 'stage_complete')!;
    // Full output, not truncated
    expect(entry.output).toEqual(largeOutput);
    // output_summary and output_fields should NOT be logged
    expect(entry).not.toHaveProperty('output_summary');
    expect(entry).not.toHaveProperty('output_fields');
    // tool_calls is the full array, not a count
    expect(entry.tool_calls).toEqual([
      { name: 'repo_manager-write_file', arguments_summary: 'src/a.ts' },
      { name: 'repo_manager-write_file', arguments_summary: 'src/b.ts' },
    ]);
  });

  it('handles stage_complete with no output', async () => {
    const { mergeEvents } = await import('../src/commands/run.js');
    const { logger, entries } = createCapturingLogger();
    const noopEvents: EngineEvents = {};

    const events = mergeEvents(noopEvents, logger, 'pipe', 'input');
    events.onPipelineStart!({ pipeline_name: 'pipe', run_id: 'run-12345678' });

    events.onStageComplete!({
      stage_name: 'analysis',
      stage_index: 0,
      total_stages: 1,
      status: 'failed',
      attempts: 3,
      duration_ms: 10000,
    });

    const entry = entries.find(e => e.event === 'stage_complete')!;
    expect(entry.output).toBeUndefined();
    expect(entry.tool_calls).toBeUndefined();
  });
});

describe('mergeEvents — stage_retry', () => {
  it('logs all failures, real max_attempts, and diagnostic fields', async () => {
    const { mergeEvents } = await import('../src/commands/run.js');
    const { logger, entries } = createCapturingLogger();
    const noopEvents: EngineEvents = {};

    const events = mergeEvents(noopEvents, logger, 'pipe', 'input');
    events.onPipelineStart!({ pipeline_name: 'pipe', run_id: 'run-12345678' });

    events.onTaskRetry!({
      stage: 'code-generation',
      attempt: 2,
      max_attempts: 3,
      failures: [
        'missing required field: summary',
        'tool_calls.minimum: expected 1, got 0',
      ],
      agent_output_raw: '{"partial": "data"}',
      tool_calls_count: 0,
    });

    const entry = entries.find(e => e.event === 'stage_retry')!;
    expect(entry.stage).toBe('code-generation');
    expect(entry.attempt).toBe(2);
    expect(entry.max_attempts).toBe(3);
    expect(entry.failures).toEqual([
      'missing required field: summary',
      'tool_calls.minimum: expected 1, got 0',
    ]);
    expect(entry.agent_output_raw).toBe('{"partial": "data"}');
    expect(entry.tool_calls_count).toBe(0);
  });
});
