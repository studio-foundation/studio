// Agent configuration and profiles

export interface AgentConfig {
  name: string;
  description?: string;
  provider: string;
  model: string;
  system_prompt?: string;
  tools?: string[];
  temperature?: number;
  max_tokens?: number;
}

export interface AgentProfile extends AgentConfig {
  // Additional profile-specific fields
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
}
