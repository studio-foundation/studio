// Validation engine
import type { ValidationResult, OutputContract, FieldSpec, FieldType, ToolCall, ToolCallRequirements } from '@studio-foundation/contracts';

export type { ToolCallRequirements } from '@studio-foundation/contracts';

export type Validator<T> = (result: T) => ValidationResult | Promise<ValidationResult>;

export interface AgentRunResult {
  output: unknown;
  tool_calls: ToolCall[];
}

/** Human-readable JSON type of a runtime value, for error messages. */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Does `value` match the declared field `type`? */
function matchesType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
  }
}

/**
 * The type a spec effectively requires. An explicit `type` wins; otherwise it's
 * inferred from structural keys so that `items` implies array and
 * `required_fields`/`fields` imply object. This makes the nested checks below
 * safe: if the effective type is enforced, the runtime shape is guaranteed.
 */
function effectiveType(spec: FieldSpec): FieldType | undefined {
  if (spec.type) return spec.type;
  if (spec.items) return 'array';
  if (spec.required_fields || spec.fields) return 'object';
  return undefined;
}

/**
 * Validate a single field value against its spec, accumulating errors with a
 * dotted/indexed `path` (e.g. `pages[2].importance`) so failures point at the
 * exact location. Recurses into object fields and array items.
 */
function validateField(value: unknown, spec: FieldSpec, path: string, errors: string[]): void {
  const type = effectiveType(spec);

  // Type gate — on mismatch, stop: enum/nested checks assume the type held.
  if (type && !matchesType(value, type)) {
    errors.push(`Field '${path}' must be ${type}, got ${describeType(value)}`);
    return;
  }

  // Enumeration — value must be one of the allowed literals.
  if (spec.enum && spec.enum.length > 0 && !spec.enum.some((allowed) => allowed === value)) {
    errors.push(
      `Field '${path}' must be one of [${spec.enum.join(', ')}], got ${JSON.stringify(value)}`
    );
  }

  // Nested object: required sub-fields and per-field specs.
  if ((spec.required_fields || spec.fields) && matchesType(value, 'object')) {
    const obj = value as Record<string, unknown>;
    if (spec.required_fields) {
      for (const field of spec.required_fields) {
        if (!(field in obj)) {
          errors.push(`Missing required field: ${path}.${field}`);
        }
      }
    }
    if (spec.fields) {
      for (const [name, childSpec] of Object.entries(spec.fields)) {
        if (name in obj) {
          validateField(obj[name], childSpec, `${path}.${name}`, errors);
        }
      }
    }
  }

  // Array items: every element must satisfy the item spec.
  if (spec.items && Array.isArray(value)) {
    value.forEach((item, index) => {
      validateField(item, spec.items as FieldSpec, `${path}[${index}]`, errors);
    });
  }
}

export function validateSchema(output: unknown, contract: OutputContract): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const schema = contract.schema;

  // Nothing to check without required_fields or field specs.
  if (!schema || (!schema.required_fields && !schema.fields)) {
    return { valid: true, errors, warnings };
  }

  // Output must be an object to check fields
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    errors.push(`Expected object output, got ${describeType(output)}`);
    return { valid: false, errors, warnings };
  }

  const outputObj = output as Record<string, unknown>;

  // Top-level presence check (required_fields)
  if (schema.required_fields) {
    for (const field of schema.required_fields) {
      if (!(field in outputObj)) {
        errors.push(`Missing required field: ${field}`);
      }
    }
  }

  // Field-level shape check (type / enum / nested) — only for present fields.
  if (schema.fields) {
    for (const [name, spec] of Object.entries(schema.fields)) {
      if (name in outputObj) {
        validateField(outputObj[name], spec, name, errors);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

function isSuccessfulToolCall(tc: ToolCall): boolean {
  return !tc.error;
}

export function validateToolCalls(toolCalls: ToolCall[], requirements?: ToolCallRequirements): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const successfulCount = toolCalls.filter(isSuccessfulToolCall).length;
  const failedCount = toolCalls.length - successfulCount;

  if (requirements?.minimum !== undefined) {
    if (successfulCount < requirements.minimum) {
      const plural = requirements.minimum === 1 ? '' : 's';
      const excluded = failedCount > 0 ? ` (${failedCount} failed excluded)` : '';
      errors.push(
        `Expected at least ${requirements.minimum} successful tool call${plural}, got ${successfulCount} successful${excluded}`
      );
    }
  }

  if (requirements?.maximum !== undefined) {
    if (successfulCount > requirements.maximum) {
      const plural = successfulCount === 1 ? '' : 's';
      errors.push(
        `Tool call limit exceeded: made ${successfulCount} successful call${plural}, maximum is ${requirements.maximum}. ` +
        `This may indicate a loop. Check that the agent is not repeating the same operation.`
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Normalize tool name: dots → hyphens so both conventions match */
function normalizeToolName(name: string): string {
  return name.replace(/\./g, '-');
}

export function validateRequiredTools(toolCalls: ToolCall[], requirements?: ToolCallRequirements): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (requirements?.required_tools && requirements.required_tools.length > 0) {
    for (const requiredTool of requirements.required_tools) {
      const normalizedRequired = normalizeToolName(requiredTool);
      const matchingCalls = toolCalls.filter(tc => normalizeToolName(tc.name) === normalizedRequired);

      if (matchingCalls.length === 0) {
        errors.push(`Required tool '${requiredTool}' was not called`);
      } else if (!matchingCalls.some(isSuccessfulToolCall)) {
        errors.push(`Required tool '${requiredTool}' has no successful calls (called ${matchingCalls.length} time${matchingCalls.length === 1 ? '' : 's'}, all failed)`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateCountedTools(toolCalls: ToolCall[], requirements?: ToolCallRequirements): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (requirements?.counted_tools && requirements.counted_tools.length > 0 && requirements?.minimum !== undefined) {
    const countedSet = new Set(requirements.counted_tools.map(normalizeToolName));
    const count = toolCalls.filter(
      tc => countedSet.has(normalizeToolName(tc.name)) && isSuccessfulToolCall(tc)
    ).length;

    if (count < requirements.minimum) {
      const toolNames = requirements.counted_tools.join(', ');
      errors.push(
        `Expected at least ${requirements.minimum} successful call${requirements.minimum === 1 ? '' : 's'} to counted tools [${toolNames}], got ${count}`
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateToolGroups(toolCalls: ToolCall[], requirements?: ToolCallRequirements): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (requirements?.required_tool_groups) {
    for (const group of requirements.required_tool_groups) {
      if (group.length === 0) continue;
      const normalizedGroup = new Set(group.map(normalizeToolName));
      const satisfied = toolCalls.some(
        tc => normalizedGroup.has(normalizeToolName(tc.name)) && isSuccessfulToolCall(tc)
      );
      if (!satisfied) {
        errors.push(
          `Expected at least one successful call from [${group.join(', ')}], got none`
        );
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function compose<T>(...validators: Validator<T>[]): Validator<T> {
  return async (result: T): Promise<ValidationResult> => {
    const results = await Promise.all(
      validators.map(v => Promise.resolve(v(result)))
    );

    return {
      valid: results.every(r => r.valid),
      errors: results.flatMap(r => r.errors),
      warnings: results.flatMap(r => r.warnings)
    };
  };
}
