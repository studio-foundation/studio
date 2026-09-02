import { describe, it, expect } from 'vitest';
import { toolErrorFingerprint } from '../src/pipeline/stage-executor.js';
import type { ToolCall } from '@studio-foundation/contracts';

const ok = (name: string): ToolCall => ({ id: name, name, arguments: {} });
const bad = (name: string, error: string): ToolCall => ({ id: name + error, name, arguments: {}, error });

describe('toolErrorFingerprint', () => {
  it('is undefined when nothing failed, so the loop keeps its retries', () => {
    expect(toolErrorFingerprint({ tool_calls: [ok('a'), ok('b')] })).toBeUndefined();
    expect(toolErrorFingerprint({ tool_calls: [] })).toBeUndefined();
    expect(toolErrorFingerprint({})).toBeUndefined();
  });

  it('matches across attempts whose successful calls differ', () => {
    const first = { tool_calls: [ok('search'), bad('create_draft', 'HTTP 400')] };
    const second = { tool_calls: [ok('search'), ok('memory'), bad('create_draft', 'HTTP 400')] };
    expect(toolErrorFingerprint(first)).toBe(toolErrorFingerprint(second));
  });

  it('ignores the order the failures came in', () => {
    const a = { tool_calls: [bad('x', 'E1'), bad('y', 'E2')] };
    const b = { tool_calls: [bad('y', 'E2'), bad('x', 'E1')] };
    expect(toolErrorFingerprint(a)).toBe(toolErrorFingerprint(b));
  });

  it('ignores how many times the same call was retried within one attempt', () => {
    const once = { tool_calls: [bad('x', 'E1')] };
    const thrice = { tool_calls: [bad('x', 'E1'), bad('x', 'E1'), bad('x', 'E1')] };
    expect(toolErrorFingerprint(once)).toBe(toolErrorFingerprint(thrice));
  });

  it('separates a different error on the same tool', () => {
    expect(toolErrorFingerprint({ tool_calls: [bad('x', 'HTTP 400')] }))
      .not.toBe(toolErrorFingerprint({ tool_calls: [bad('x', 'HTTP 429')] }));
  });

  it('separates the same error on a different tool', () => {
    expect(toolErrorFingerprint({ tool_calls: [bad('x', 'HTTP 400')] }))
      .not.toBe(toolErrorFingerprint({ tool_calls: [bad('y', 'HTTP 400')] }));
  });

  it('separates a failure set that grew', () => {
    expect(toolErrorFingerprint({ tool_calls: [bad('x', 'E1')] }))
      .not.toBe(toolErrorFingerprint({ tool_calls: [bad('x', 'E1'), bad('y', 'E2')] }));
  });
});
