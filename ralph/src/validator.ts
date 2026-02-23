// Validation engine
import type { ValidationResult, OutputContract, ToolCall } from '@studio/contracts';

export type Validator<T> = (result: T) => ValidationResult | Promise<ValidationResult>;

export interface AgentRunResult {
  output: unknown;
  tool_calls: ToolCall[];
}

export interface ToolCallRequirements {
  minimum?: number;
  required_tools?: string[];
  counted_tools?: string[];
}

export function validateSchema(output: unknown, contract: OutputContract): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // If no schema defined, consider it valid
  if (!contract.schema || !contract.schema.required_fields) {
    return { valid: true, errors, warnings };
  }

  const requiredFields = contract.schema.required_fields as string[];

  // Output must be an object to check fields
  if (output === null || typeof output !== 'object') {
    errors.push(`Expected object output, got ${output === null ? 'null' : typeof output}`);
    return { valid: false, errors, warnings };
  }

  const outputObj = output as Record<string, unknown>;

  // Check each required field
  for (const field of requiredFields) {
    if (!(field in outputObj)) {
      errors.push(`Missing required field: ${field}`);
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

  if (requirements?.minimum !== undefined) {
    const successfulCount = toolCalls.filter(isSuccessfulToolCall).length;
    const failedCount = toolCalls.length - successfulCount;

    if (successfulCount < requirements.minimum) {
      const plural = requirements.minimum === 1 ? '' : 's';
      const excluded = failedCount > 0 ? ` (${failedCount} failed excluded)` : '';
      errors.push(
        `Expected at least ${requirements.minimum} successful tool call${plural}, got ${successfulCount} successful${excluded}`
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

  // Check required tools (normalize names so dots and hyphens both match)
  if (requirements?.required_tools && requirements.required_tools.length > 0) {
    const calledTools = new Set(toolCalls.map(tc => normalizeToolName(tc.name)));

    for (const requiredTool of requirements.required_tools) {
      if (!calledTools.has(normalizeToolName(requiredTool))) {
        errors.push(`Required tool '${requiredTool}' was not called`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

export function validateCountedTools(toolCalls: ToolCall[], requirements?: ToolCallRequirements): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (requirements?.counted_tools && requirements.counted_tools.length > 0 && requirements?.minimum !== undefined) {
    const countedSet = new Set(requirements.counted_tools.map(normalizeToolName));
    const count = toolCalls.filter(tc => countedSet.has(normalizeToolName(tc.name))).length;

    if (count < requirements.minimum) {
      const toolNames = requirements.counted_tools.join(', ');
      errors.push(
        `Expected at least ${requirements.minimum} call${requirements.minimum === 1 ? '' : 's'} to counted tools [${toolNames}], got ${count}`
      );
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
