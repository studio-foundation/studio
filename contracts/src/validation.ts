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
 * This is the escape hatch for validation the declarative schema cannot express
 * (cross-field rules, computed constraints) and for validators written in another
 * language. Field-level shape — types, enums, nested required fields — now lives
 * declaratively in `schema.fields` (see FieldSpec); reach for an external validator
 * only when a rule spans multiple fields or needs real code. Unlike a required tool,
 * it runs against the ACTUAL stage output, so the agent cannot satisfy it by
 * reporting different arguments than it emits.
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

/**
 * The JSON type a field is expected to hold. `integer` is `number` narrowed to
 * whole values; `object` excludes arrays and null (use `array` for lists).
 */
export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

/**
 * Declarative shape of a single field — the piece that lifts contract validation
 * beyond "the key is present" (required_fields) to "the value is the right type,
 * one of the allowed values, and structurally sound".
 *
 * Every check is optional and only fires when the field is actually present;
 * presence is still governed by `required_fields`. This keeps the two orthogonal:
 * `required_fields` says a field must exist, `fields` says what it must look like.
 *
 * Recursion covers nested structures the PoC contracts need:
 *   - `type: object` + `required_fields`/`fields` validates a sub-object
 *   - `type: array` + `items` validates every element (e.g. each `pages[]` entry)
 */
export interface FieldSpec {
  /** Expected JSON type. On mismatch the field fails and nested checks are skipped. */
  type?: FieldType;
  /** Allowed values (enumeration), compared with strict equality. */
  enum?: Array<string | number | boolean>;
  /** For objects: names of nested fields that must be present. */
  required_fields?: string[];
  /** For objects: per-field specs applied to nested fields that are present. */
  fields?: Record<string, FieldSpec>;
  /** For arrays: the spec every element must satisfy. */
  items?: FieldSpec;
}

/**
 * A stage's output schema. `required_fields` checks top-level presence; `fields`
 * adds declarative type/enum/nested validation for the fields it names. Both are
 * optional and compose — a contract can use either, both, or neither.
 */
export interface OutputSchema {
  required_fields?: string[];
  fields?: Record<string, FieldSpec>;
}

export interface OutputContract {
  name: string;
  version: number;
  schema?: OutputSchema;
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
