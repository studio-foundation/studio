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
 * one summary turn from `summarizer`.
 *
 * Every provider path here keeps strict user/assistant alternation, since some
 * providers (Anthropic) reject two consecutive same-role messages outright: the
 * summary is a full (assistant, user) turn, not a single message dropped in after
 * `head`, which already ends on 'user'.
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

  // toSummarize always ends on 'user' (each turn is an assistant/user pair), so the
  // instruction is folded into that last message rather than sent as its own —
  // a separate 'user' message here would be two 'user' turns back to back.
  const lastMessage = toSummarize[toSummarize.length - 1];
  const summaryRequest: Message[] = [
    ...toSummarize.slice(0, -1),
    { ...lastMessage, content: `${lastMessage.content}\n\n${SUMMARY_INSTRUCTION}` },
  ];

  const provider = providerRegistry.get(summarizer.provider);
  const response = await provider.call({
    model: summarizer.model,
    messages: summaryRequest,
    temperature: summarizer.temperature,
    max_tokens: summarizer.max_tokens,
  });

  const summaryTurn: Message[] = [
    { role: 'assistant', content: '' },
    { role: 'user', content: `## Earlier turns (summarized)\n\n${response.content}` },
  ];

  return {
    messages: [...head, ...summaryTurn, ...toKeep],
    usage: response.usage,
  };
}
