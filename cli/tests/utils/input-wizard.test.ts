import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InputSchema } from '@studio-foundation/contracts';
import { collectStructuredInput } from '../../src/utils/input-wizard.js';

// Mock @inquirer/prompts at module level
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
}));
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

describe('collectStructuredInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('collects a single text field', async () => {
    const { input: mockInput } = await import('@inquirer/prompts');
    (mockInput as ReturnType<typeof vi.fn>).mockResolvedValueOnce('Add dark mode');

    const schema: InputSchema = {
      type: 'structured',
      fields: [{ name: 'brief_summary', type: 'text', prompt: 'Brief summary', required: true }],
    };

    const result = await collectStructuredInput(schema);

    expect(result).toEqual({ brief_summary: 'Add dark mode' });
    expect(mockInput).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Brief summary' })
    );
  });

  it('collects an array field with multiple entries', async () => {
    const { input: mockInput } = await import('@inquirer/prompts');
    (mockInput as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('First criterion')
      .mockResolvedValueOnce('Second criterion')
      .mockResolvedValueOnce('');  // empty → stop

    const schema: InputSchema = {
      type: 'structured',
      fields: [{ name: 'criteria', type: 'array', items: 'text', prompt: 'Criteria', required: true }],
    };

    const result = await collectStructuredInput(schema);

    expect(result).toEqual({ criteria: ['First criterion', 'Second criterion'] });
  });

  it('collects multiple fields', async () => {
    const { input: mockInput } = await import('@inquirer/prompts');
    (mockInput as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('Add dark mode')   // text field
      .mockResolvedValueOnce('Must work')        // array entry 1
      .mockResolvedValueOnce('');                // array stop

    const schema: InputSchema = {
      type: 'structured',
      fields: [
        { name: 'summary', type: 'text', prompt: 'Summary', required: true },
        { name: 'criteria', type: 'array', items: 'text', prompt: 'Criteria', required: true },
      ],
    };

    const result = await collectStructuredInput(schema);

    expect(result).toEqual({ summary: 'Add dark mode', criteria: ['Must work'] });
  });
});
