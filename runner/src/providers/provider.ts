/**
 * Provider interface - aligned with @studio/contracts
 */

import type { LLMRequest, LLMResponse } from '@studio/contracts';

export interface Provider {
  readonly name: string;
  call(request: LLMRequest): Promise<LLMResponse>;
}

export interface ToolCallOutcome {
  result?: unknown;
  error?: string;
}

/**
 * Extended interface for providers that own the full agent loop.
 * Used by providers (e.g. OpenAI Responses API) where multi-turn
 * tool calling cannot be expressed as plain text messages.
 */
export interface AgentLoopProvider extends Provider {
  runAgentLoop(
    request: LLMRequest,
    executeTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<ToolCallOutcome>
  ): Promise<AgentLoopResult>;
}

/**
 * Full result of an agent loop execution.
 * Distinct from LLMResponse (in @studio/contracts) because it includes
 * per-tool-call execution outcomes (result/error) that are only known
 * after the runner has actually invoked each tool.
 */
export interface AgentLoopResult {
  content: string;
  tool_calls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  } & ToolCallOutcome>;
  finish_reason: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export function isAgentLoopProvider(p: Provider): p is AgentLoopProvider {
  return typeof (p as AgentLoopProvider).runAgentLoop === 'function';
}
