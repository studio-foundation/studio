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
