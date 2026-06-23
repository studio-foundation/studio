import type { TaskInput } from '@studio-foundation/runner';

/**
 * Build the runner's {@link TaskInput} from a pipeline input.
 *
 * A string input becomes the flat `description` (the default path). A record
 * input is kept as named `fields` so anonymization can address each field
 * before prompt assembly — field names are OPAQUE to the engine (no domain
 * meaning). Non-string field values are stringified so every field is text.
 */
export function buildTaskInput(
  userInput: string | Record<string, unknown>,
  contractName?: string,
): TaskInput {
  if (typeof userInput === 'string') {
    return { description: userInput, contract_name: contractName };
  }

  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(userInput)) {
    fields[name] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return { description: '', fields, contract_name: contractName };
}
