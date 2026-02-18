// Error types and codes

export enum ErrorCode {
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  AGENT_EXECUTION_FAILED = 'AGENT_EXECUTION_FAILED',
  STAGE_FAILED = 'STAGE_FAILED',
  PIPELINE_FAILED = 'PIPELINE_FAILED',
  RALPH_EXHAUSTED = 'RALPH_EXHAUSTED',
  TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED',
  PROVIDER_ERROR = 'PROVIDER_ERROR',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
}

export class StudioError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'StudioError';
  }
}
