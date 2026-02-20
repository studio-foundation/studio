/**
 * Event types for real-time tool call streaming.
 * Defined in contracts (leaf package) so runner can import them
 * without creating an inverse dependency on engine.
 */

export interface ToolCallStartEvent {
  tool: string;
  params: Record<string, unknown>;
  timestamp: number; // ms since epoch (Date.now())
}

export interface ToolCallCompleteEvent {
  tool: string;
  result: unknown; // tool-plugin-specific; typed by each tool plugin
  error?: string;
  duration_ms: number;
  timestamp: number; // ms since epoch (Date.now())
}

export interface AgentThinkingEvent {
  thought: string;   // LLM text content emitted before the first round of tool calls
  timestamp: number; // ms since epoch (Date.now())
}

export interface AgentProgressEvent {
  message: string;   // LLM text content emitted between subsequent rounds of tool calls
  timestamp: number; // ms since epoch (Date.now())
}

/**
 * Subset of callbacks the runner accepts for real-time event emission.
 * Engine populates these from EngineEvents and passes them to runAgent().
 */
export interface RunnerCallbacks {
  onToolCallStart?: (event: ToolCallStartEvent) => void;
  onToolCallComplete?: (event: ToolCallCompleteEvent) => void;
  onAgentThinking?: (event: AgentThinkingEvent) => void;
  onAgentProgress?: (event: AgentProgressEvent) => void;
}
