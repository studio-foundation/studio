// runner/src/tools/errors.test.ts
import { describe, it, expect } from 'vitest';
import { ToolYamlError } from './errors.js';

describe('ToolYamlError', () => {
  it('is an Error with name ToolYamlError', () => {
    const err = new ToolYamlError('bad yaml');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ToolYamlError');
    expect(err.message).toBe('bad yaml');
  });
});
