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

/**
 * Post-execution filesystem check: the files/artifacts a stage MUST leave on
 * disk to be considered done. A "success" return code doesn't prove the agent
 * actually produced its outputs — this closes that gap. Each entry is a path or
 * glob (relative to the repo workspace); a stage fails if any entry matches no
 * existing file. Runs inside the RALPH loop, so a miss enriches the retry
 * feedback before the stage is finally failed.
 */
export interface ExpectedOutputs {
  /** Paths or glob patterns (relative to the repo workspace). Each must match ≥1 existing file. */
  files: string[];
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
  /** Files/artifacts the stage must leave on disk. Checked post-execution. */
  expected_outputs?: ExpectedOutputs;
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
