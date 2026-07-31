// Agent configuration and profiles

/**
 * What an agent asks the provider to do about prompt caching.
 *
 * - `auto` (default) — cache only when the stage is expected to run more than one
 *   turn against the same prefix, which is what makes a cache write pay for itself.
 * - `on` — always cache. For a fan-out whose items have been measured to share a
 *   prefix long enough to beat the write premium.
 * - `off` — never cache, whatever the stage looks like.
 */
export type PromptCacheMode = 'auto' | 'on' | 'off';

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
  /** Prompt-cache policy for this agent's calls. Default `auto`. */
  prompt_cache?: PromptCacheMode;
}

/** AgentConfig after defaults have been applied — provider and model are guaranteed. */
export interface ResolvedAgentConfig extends AgentConfig {
  provider: string;
  model: string;
}

export type AgentProfile = AgentConfig;

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
}
