// LLM provider interfaces

import type { TokenUsage } from './usage';

export interface LLMRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  max_tokens?: number;
  stage_name?: string;
  json_mode?: boolean;
  /**
   * Whether the provider should mark this call's stable prefix (system prompt +
   * tool definitions) as cacheable. A cache write is billed above the plain input
   * rate and only pays for itself once something reads it back, so a call that
   * will never have a successor costs MORE with caching on than off. The caller
   * decides — it is the only party that knows whether a second turn is coming.
   * Absent means no: providers must not cache speculatively.
   */
  cache_prompt?: boolean;
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  finish_reason: string;
  /** What the call cost, as the provider reported it. See ./usage.ts. */
  usage?: TokenUsage;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
