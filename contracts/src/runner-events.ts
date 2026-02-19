/**
 * Event types for real-time tool call streaming.
 * Defined in contracts (leaf package) so runner can import them
 * without creating an inverse dependency on engine.
 */

export interface ToolCallStartEvent {
  tool: string;
  params: Record<string, unknown>;
  timestamp: string;
}

export interface ToolCallCompleteEvent {
  tool: string;
  result: unknown;
  error?: string;
  duration_ms: number;
  timestamp: string;
}

/**
 * Subset of callbacks the runner accepts for real-time event emission.
 * Engine populates these from EngineEvents and passes them to runAgent().
 */
export interface RunnerCallbacks {
  onToolCallStart?: (event: ToolCallStartEvent) => void;
  onToolCallComplete?: (event: ToolCallCompleteEvent) => void;
}
