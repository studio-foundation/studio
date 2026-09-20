import { describe, it, expect } from 'vitest';
import { formatEventLine } from '../../src/commands/logs.js';

describe('formatEventLine stage_retry', () => {
  it('prints every failure reason', () => {
    const line = formatEventLine({
      event: 'stage_retry',
      attempt: 2,
      failures: ['Missing required field: a', "Required tool 'x' was not called"],
    });
    expect(line).toContain('Retry #2');
    expect(line).toContain('Missing required field: a');
    expect(line).toContain("Required tool 'x' was not called");
  });

  it.each([[undefined], [[]]])('falls back to unknown when failures is %j', (failures) => {
    expect(formatEventLine({ event: 'stage_retry', attempt: 1, failures })).toContain('unknown');
  });
});
