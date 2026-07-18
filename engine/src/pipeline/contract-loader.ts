// Load output contracts from YAML files

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { OutputContract } from '@studio-foundation/contracts';
import { assertKnownFields } from './strict-fields.js';

// Every field the kernel implements for contracts, per block (see OutputContract).
// A field listed nowhere here is config-theatre and must be rejected, not ignored.
const CONTRACT_FIELDS = [
  'name', 'version', 'schema', 'tool_calls', 'validators',
  'custom_rules', 'post_validation', 'expected_outputs',
] as const;
const SCHEMA_FIELDS = ['required_fields', 'fields'] as const;
const FIELD_SPEC_FIELDS = ['type', 'enum', 'required_fields', 'fields', 'items'] as const;
const EXPECTED_OUTPUTS_FIELDS = ['files'] as const;
const TOOL_CALLS_FIELDS = [
  'minimum', 'maximum', 'required_tools', 'required_tool_groups', 'counted_tools',
] as const;
const VALIDATOR_FIELDS = ['name', 'command', 'timeout_ms'] as const;
const CUSTOM_RULE_FIELDS = ['name', 'description', 'check'] as const;
const POST_VALIDATION_FIELDS = ['rejection_detection'] as const;
const REJECTION_DETECTION_FIELDS = [
  'field', 'rejected_values', 'approved_values',
  'details_field', 'summary_field', 'reject_if_non_empty',
] as const;

export async function loadContract(
  name: string,
  contractsDir: string
): Promise<OutputContract> {
  const path = join(contractsDir, `${name}.contract.yaml`);

  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to load contract '${name}' at ${path}: ${(err as Error).message}`);
  }

  return parseContractYaml(content, path);
}

export function parseContractYaml(yamlContent: string, sourcePath?: string): OutputContract {
  const parsed = yaml.load(yamlContent) as Record<string, unknown>;
  const context = sourcePath ? ` (from ${sourcePath})` : '';

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid contract YAML: expected an object${context}`);
  }

  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error(`Contract missing required field 'name'${context}`);
  }

  if (parsed.version === undefined) {
    throw new Error(`Contract missing required field 'version'${context}`);
  }

  const inContract = `of contract '${parsed.name}'`;
  assertKnownFields(parsed, CONTRACT_FIELDS, `contract '${parsed.name}'`, context);

  const check = (block: unknown, allowed: readonly string[], what: string) => {
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      assertKnownFields(block as Record<string, unknown>, allowed, `${what} ${inContract}`, context);
    }
  };

  check(parsed.schema, SCHEMA_FIELDS, 'schema');
  const schemaFields = (parsed.schema as Record<string, unknown> | undefined)?.fields;
  if (schemaFields && typeof schemaFields === 'object' && !Array.isArray(schemaFields)) {
    checkFieldSpecs(schemaFields as Record<string, unknown>, 'schema.fields', inContract, context);
  }
  check(parsed.tool_calls, TOOL_CALLS_FIELDS, 'tool_calls');
  check(parsed.expected_outputs, EXPECTED_OUTPUTS_FIELDS, 'expected_outputs');
  check(parsed.post_validation, POST_VALIDATION_FIELDS, 'post_validation');
  const rejectionDetection = (parsed.post_validation as Record<string, unknown> | undefined)
    ?.rejection_detection;
  check(rejectionDetection, REJECTION_DETECTION_FIELDS, 'post_validation.rejection_detection');

  if (Array.isArray(parsed.validators)) {
    for (const v of parsed.validators) check(v, VALIDATOR_FIELDS, 'validators entry');
  }
  if (Array.isArray(parsed.custom_rules)) {
    for (const r of parsed.custom_rules) check(r, CUSTOM_RULE_FIELDS, 'custom_rules entry');
  }

  return parsed as unknown as OutputContract;
}

/**
 * Fail-loud strict check for `schema.fields`: every field spec, and every nested
 * spec inside `fields`/`items`, may only carry keys the validator implements. A
 * stray key here (e.g. `min_items`, `pattern`) is config-theatre — it must be
 * rejected at load time, not silently ignored, exactly like the top-level blocks.
 */
function checkFieldSpecs(
  fields: Record<string, unknown>,
  path: string,
  inContract: string,
  context: string
): void {
  for (const [name, spec] of Object.entries(fields)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
    const specObj = spec as Record<string, unknown>;
    assertKnownFields(specObj, FIELD_SPEC_FIELDS, `${path}.${name} ${inContract}`, context);

    if (specObj.fields && typeof specObj.fields === 'object' && !Array.isArray(specObj.fields)) {
      checkFieldSpecs(specObj.fields as Record<string, unknown>, `${path}.${name}.fields`, inContract, context);
    }
    if (specObj.items && typeof specObj.items === 'object' && !Array.isArray(specObj.items)) {
      // `items` is itself a single field spec; check it under a one-entry map.
      checkFieldSpecs({ '[]': specObj.items }, `${path}.${name}.items`, inContract, context);
    }
  }
}
