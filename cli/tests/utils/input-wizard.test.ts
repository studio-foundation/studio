import { describe, it, expect } from 'vitest';
import { validateInputSchema } from '../../src/utils/input-wizard.js';

describe('validateInputSchema', () => {
  it('accepts a valid text field', () => {
    const result = validateInputSchema({
      type: 'structured',
      fields: [{ name: 'brief_summary', type: 'text', prompt: 'Brief summary', required: true }],
    });
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].name).toBe('brief_summary');
  });

  it('accepts a valid array field', () => {
    const result = validateInputSchema({
      type: 'structured',
      fields: [{ name: 'criteria', type: 'array', items: 'text', prompt: 'Criteria', required: true }],
    });
    expect(result.fields[0].type).toBe('array');
  });

  it('accepts an optional field with a default', () => {
    const result = validateInputSchema({
      type: 'structured',
      fields: [{ name: 'page', type: 'text', prompt: 'Target page', required: false, default: 'src/index.ts' }],
    });
    expect(result.fields[0].default).toBe('src/index.ts');
  });

  it('throws when fields is missing', () => {
    expect(() => validateInputSchema({ type: 'structured' })).toThrow(
      'input_schema must have at least one field'
    );
  });

  it('throws when fields is empty', () => {
    expect(() => validateInputSchema({ type: 'structured', fields: [] })).toThrow(
      'input_schema must have at least one field'
    );
  });

  it('throws when a field is missing prompt', () => {
    expect(() =>
      validateInputSchema({
        type: 'structured',
        fields: [{ name: 'foo', type: 'text', required: true }],
      })
    ).toThrow("Field 'foo' must have a non-empty 'prompt'");
  });

  it('throws when a field has empty prompt', () => {
    expect(() =>
      validateInputSchema({
        type: 'structured',
        fields: [{ name: 'foo', type: 'text', prompt: '  ', required: true }],
      })
    ).toThrow("Field 'foo' must have a non-empty 'prompt'");
  });

  it('throws when a field has invalid type', () => {
    expect(() =>
      validateInputSchema({
        type: 'structured',
        fields: [{ name: 'foo', type: 'number', prompt: 'Foo', required: true }],
      })
    ).toThrow("Field 'foo' has invalid type 'number'. Must be 'text' or 'array'");
  });

  it('throws when an array field is missing items', () => {
    expect(() =>
      validateInputSchema({
        type: 'structured',
        fields: [{ name: 'foo', type: 'array', prompt: 'Foo', required: true }],
      })
    ).toThrow("Array field 'foo' must have items: 'text'");
  });

  it('throws when an array field has non-text items', () => {
    expect(() =>
      validateInputSchema({
        type: 'structured',
        fields: [{ name: 'foo', type: 'array', items: 'number', prompt: 'Foo', required: true }],
      })
    ).toThrow("Array field 'foo' must have items: 'text'");
  });
});
