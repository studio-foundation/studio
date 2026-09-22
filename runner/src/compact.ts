import type { Message, ResolvedAgentConfig, TokenUsage } from '@studio-foundation/contracts';
import type { ProviderRegistry } from './providers/registry.js';

export interface CompactionResult {
  messages: Message[];
  /** The summarization call's own cost, when one was made. */
  usage?: TokenUsage;
}

const SUMMARY_INSTRUCTION =
  'Summarize the conversation above concisely, in plain text: what was asked, which ' +
  'tools were called and with what result, and any facts or decisions a continuation ' +
  'would need. No preamble.';

/**
 * Compacts a standard multi-turn loop's message history: `messages[0]` (system prompt)
 * and `messages[1]` (the original task) are always kept, the most recent `keepLastTurns`
 * (assistant, tool-result) pairs are kept verbatim, and everything older is replaced by
 * one summary message from `summarizer`.
 *
 * A no-op (returns `messages` unchanged, no summarizer call) when there aren't enough
 * older turns to drop yet.
 */
export async function compactMessages(
  messages: Message[],
  keepLastTurns: number,
  summarizer: ResolvedAgentConfig,
  providerRegistry: ProviderRegistry,
): Promise<CompactionResult> {
  const head = messages.slice(0, 2);
  const turns = messages.slice(2);
  const keepCount = keepLastTurns * 2; // each turn is an (assistant, user) pair

  if (turns.length <= keepCount) {
    return { messages };
  }

  const toSummarize = turns.slice(0, turns.length - keepCount);
  const toKeep = turns.slice(turns.length - keepCount);

  const provider = providerRegistry.get(summarizer.provider);
  const response = await provider.call({
    model: summarizer.model,
    messages: [...toSummarize, { role: 'user', content: SUMMARY_INSTRUCTION }],
    temperature: summarizer.temperature,
    max_tokens: summarizer.max_tokens,
  });

  const summaryMessage: Message = {
    role: 'user',
    content: `## Earlier turns (summarized)\n\n${response.content}`,
  };

  return {
    messages: [...head, summaryMessage, ...toKeep],
    usage: response.usage,
  };
}
