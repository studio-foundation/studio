import { input } from '@inquirer/prompts';
import type { InputSchema } from '@studio-foundation/contracts';

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
  const result: Record<string, unknown> = {};

  for (const field of schema.fields) {
    if (field.type === 'text') {
      result[field.name] = await input({
        message: field.prompt,
        required: field.required,
        default: field.default,
      });
    } else if (field.type === 'array') {
      const items: string[] = [];
      let index = 1;

      while (true) {
        const value = await input({
          message: `${field.prompt} (${index})`,
          required: index === 1 && field.required,
          default: '',
        });

        if (value === '') {
          if (index === 1 && field.required) {
            console.log('At least one value required.');
            continue;
          }
          break;
        }

        items.push(value);
        index++;
      }

      result[field.name] = items;
    }
  }

  console.log('\n✓ Input collected\n');
  return result;
}
