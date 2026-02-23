// Validation contracts and results

export interface ToolCallRequirements {
  minimum?: number;
  required_tools?: string[];
  required_tool_groups?: string[][];
  counted_tools?: string[];
}

export interface OutputContract {
  name: string;
  version: number;
  schema?: {
    required_fields?: string[];
    [key: string]: unknown;
  };
  tool_calls?: ToolCallRequirements;
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
