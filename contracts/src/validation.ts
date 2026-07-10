// Validation contracts and results

export interface ToolCallRequirements {
  minimum?: number;
  maximum?: number;
  required_tools?: string[];
  required_tool_groups?: string[][];
  counted_tools?: string[];
}

/**
 * An external validator: a shell command that receives the stage output as JSON
 * on stdin and prints `{ "valid": boolean, "errors": string[] }` to stdout.
 *
 * This is the escape hatch for validation the declarative contract cannot express
 * (enums, types, cross-field rules) and for validators written in another language.
 * Unlike a required tool, it runs against the ACTUAL stage output, so the agent
 * cannot satisfy it by reporting different arguments than it emits.
 */
export interface ExternalValidator {
  name: string;
  /** Shell command. Receives the output JSON on stdin; prints {valid, errors} on stdout. */
  command: string;
  /** Optional timeout in milliseconds (default 30000). */
  timeout_ms?: number;
}

export interface OutputContract {
  name: string;
  version: number;
  schema?: {
    required_fields?: string[];
  };
  tool_calls?: ToolCallRequirements;
  /** External validators run against the real output inside the RALPH loop. */
  validators?: ExternalValidator[];
  custom_rules?: ValidationRule[];
  post_validation?: {
    rejection_detection: {
      field: string;
      rejected_values?: string[];
      approved_values?: string[];
      details_field?: string;
      summary_field?: string;
      reject_if_non_empty?: string;
    };
  };
}

export interface ValidationRule {
  name: string;
  description: string;
  check: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
