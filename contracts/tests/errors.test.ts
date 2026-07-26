import { describe, it, expect } from 'vitest';
import { ErrorCode, StudioError } from '../src/index.js';

describe('StudioError', () => {
  it('is a real Error subclass', () => {
    const err = new StudioError(ErrorCode.STAGE_FAILED, 'stage blew up');

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(StudioError);
    expect(err.name).toBe('StudioError');
    expect(err.message).toBe('stage blew up');
    expect(err.stack).toBeDefined();
  });

  it('carries the code and details', () => {
    const err = new StudioError(ErrorCode.VALIDATION_FAILED, 'invalid output', {
      stage: 'code-generation',
      missing: ['files_changed'],
    });

    expect(err.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(err.details).toEqual({
      stage: 'code-generation',
      missing: ['files_changed'],
    });
  });

  it('leaves details undefined when omitted', () => {
    expect(new StudioError(ErrorCode.PROVIDER_ERROR, 'boom').details).toBeUndefined();
  });

  it('stringifies with the StudioError name prefix', () => {
    expect(String(new StudioError(ErrorCode.RALPH_EXHAUSTED, 'no attempts left')))
      .toBe('StudioError: no attempts left');
  });

  it('is catchable as a plain Error', () => {
    expect(() => {
      throw new StudioError(ErrorCode.TOOL_EXECUTION_FAILED, 'tool died');
    }).toThrow('tool died');
  });
});

describe('ErrorCode', () => {
  // Codes cross process boundaries (run JSONL, API error payloads), so a
  // consumer matches on the string, not the enum member. Value drift is a
  // breaking change these two tests make deliberate.
  it('has values identical to their keys', () => {
    for (const [key, value] of Object.entries(ErrorCode)) {
      expect(value).toBe(key);
    }
  });

  it('exposes exactly the published set of codes', () => {
    expect(Object.keys(ErrorCode).sort()).toEqual([
      'AGENT_EXECUTION_FAILED',
      'CONFIGURATION_ERROR',
      'PIPELINE_FAILED',
      'PROVIDER_ERROR',
      'RALPH_EXHAUSTED',
      'STAGE_FAILED',
      'TOOL_EXECUTION_FAILED',
      'VALIDATION_FAILED',
    ]);
  });
});
