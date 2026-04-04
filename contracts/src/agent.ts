// Agent configuration and profiles

export interface AgentConfig {
  name: string;
  description?: string;
  provider?: string;
  model?: string;
  system_prompt?: string;
  tools?: string[];
  plugins?: string[];
  skills?: string[];
  temperature?: number;
  max_tokens?: number;
  anonymize?: boolean;  // Enable PII anonymization for this agent
}

/** AgentConfig after defaults have been applied — provider and model are guaranteed. */
export interface ResolvedAgentConfig extends AgentConfig {
  provider: string;
  model: string;
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
