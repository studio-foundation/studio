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

/**
 * Policy for compacting a stage's own multi-turn tool-calling loop once it grows
 * past a token threshold. Absent means off — an agent that never sets `compact`
 * behaves exactly as before.
 */
export interface CompactionConfig {
  /** Compact once a turn's prompt tokens, as the provider reported them, reach this. */
  threshold_tokens: number;
  /** How many of the most recent turns to keep verbatim after compacting. Default 2. */
  keep_last_turns?: number;
  /** Name of the agent (resolved like any other) that performs the summarization call. */
  summarizer: string;
}

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
  /** Compaction policy for this agent's multi-turn tool-calling loop. Default off. */
  compact?: CompactionConfig;
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
