import type { OutputContract, ToolCall } from '@studio-foundation/contracts';
import {
  validateSchema,
  validateToolCalls,
  validateRequiredTools,
  validateCountedTools,
  validateToolGroups,
} from '@studio-foundation/ralph';
import { postValidate, type PostValidationResult } from './post-validator.js';

export interface OutputValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  post_validation: PostValidationResult;
}

export function validateOutput(
  contract: OutputContract,
  output: unknown,
  toolCalls: ToolCall[] = []
): OutputValidationResult {
  const results = [
    validateSchema(output, contract),
    validateToolCalls(toolCalls, contract.tool_calls),
    validateRequiredTools(toolCalls, contract.tool_calls),
    validateCountedTools(toolCalls, contract.tool_calls),
    validateToolGroups(toolCalls, contract.tool_calls),
  ];

  const errors = results.flatMap(r => r.errors);
  const warnings = results.flatMap(r => r.warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    post_validation: postValidate(output, contract),
  };
}
