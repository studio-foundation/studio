import { describe, it, expect } from 'vitest';
import type { StageRetryEvent } from '../src/events.js';

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
