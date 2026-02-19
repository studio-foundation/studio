import { input } from '@inquirer/prompts';
import type { InputSchema } from '@studio/contracts';

export function validateInputSchema(raw: unknown): InputSchema {
  const schema = raw as Record<string, unknown>;

  if (!Array.isArray(schema?.fields) || schema.fields.length === 0) {
    throw new Error('input_schema must have at least one field');
  }

  for (const field of schema.fields as any[]) {
    const name = field.name ?? '(unnamed)';

    if (!field.prompt || typeof field.prompt !== 'string' || !field.prompt.trim()) {
      throw new Error(`Field '${name}' must have a non-empty 'prompt'`);
    }

    if (field.type !== 'text' && field.type !== 'array') {
      throw new Error(
        `Field '${name}' has invalid type '${field.type}'. Must be 'text' or 'array'`
      );
    }

    if (field.type === 'array' && field.items !== 'text') {
      throw new Error(`Array field '${name}' must have items: 'text'`);
    }
  }

  return raw as InputSchema;
}

export async function collectStructuredInput(
  schema: InputSchema
): Promise<Record<string, unknown>> {
  // Implemented in Task 5
  throw new Error('not implemented');
}
