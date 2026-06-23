import { describe, it, expect } from 'vitest';
import { buildTaskInput } from './task-input.js';

describe('buildTaskInput', () => {
  it('maps a string input to the flat description (no fields)', () => {
    const t = buildTaskInput('Do the thing', 'my-contract');
    expect(t).toEqual({ description: 'Do the thing', contract_name: 'my-contract' });
    expect(t.fields).toBeUndefined();
  });

  it('keeps a record input as named string fields (no flat description rendered)', () => {
    const t = buildTaskInput({ from: 'mc@acme.com', body: 'hello' }, 'c');
    expect(t.fields).toEqual({ from: 'mc@acme.com', body: 'hello' });
    expect(t.description).toBe('');
    expect(t.contract_name).toBe('c');
  });

  it('stringifies non-string field values so every field is text', () => {
    const t = buildTaskInput({ count: 3, meta: { a: 1 }, name: 'x' });
    expect(t.fields).toEqual({ count: '3', meta: '{"a":1}', name: 'x' });
  });

  it('preserves field insertion order', () => {
    const t = buildTaskInput({ z: 'a', a: 'b', m: 'c' });
    expect(Object.keys(t.fields!)).toEqual(['z', 'a', 'm']);
  });
});
