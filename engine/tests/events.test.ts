import { describe, it, expect } from 'vitest';
import type { StageRetryEvent, StagedToolCallStartEvent, StagedToolCallCompleteEvent } from '../src/events.js';

describe('StageRetryEvent', () => {
  it('includes max_attempts field', () => {
    const event: StageRetryEvent = {
      stage: 'code-generation',
      attempt: 2,
      failures: ['missing field: summary'],
      max_attempts: 3,
    };
    expect(event.max_attempts).toBe(3);
  });

  it('includes optional agent_output_raw and tool_calls_count', () => {
    const event: StageRetryEvent = {
      stage: 'code-generation',
      attempt: 1,
      failures: ['validation failed'],
      max_attempts: 5,
      agent_output_raw: '{"summary": "incomplete"}',
      tool_calls_count: 3,
    };
    expect(event.agent_output_raw).toBe('{"summary": "incomplete"}');
    expect(event.tool_calls_count).toBe(3);
  });
});

describe('StagedToolCallStartEvent', () => {
  it('includes stage, tool, and params fields', () => {
    const event: StagedToolCallStartEvent = {
      stage: 'code-generation',
      tool: 'repo_manager-write_file',
      params: { path: 'src/foo.ts' },
      timestamp: 1700000000000,
    };
    expect(event.stage).toBe('code-generation');
    expect(event.tool).toBe('repo_manager-write_file');
    expect(event.params).toEqual({ path: 'src/foo.ts' });
  });
});

describe('StagedToolCallCompleteEvent', () => {
  it('includes stage, tool, result, and duration_ms fields', () => {
    const event: StagedToolCallCompleteEvent = {
      stage: 'code-generation',
      tool: 'repo_manager-write_file',
      result: 'written',
      duration_ms: 120,
      timestamp: 1700000000000,
    };
    expect(event.stage).toBe('code-generation');
    expect(event.tool).toBe('repo_manager-write_file');
    expect(event.duration_ms).toBe(120);
  });
});
