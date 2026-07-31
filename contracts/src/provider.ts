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
