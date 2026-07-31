/**
 * When a call's stable prefix is worth caching.
 *
 * A prompt cache is not free storage: the write is billed above the plain input
 * rate and only earns that back when a later call reads the same prefix. So the
 * question is never "is this prefix big?" but "will anything read it back?".
 *
 * A stage that answers in one turn — a fan-out item, a verdict — never issues a
 * second request, so caching it is a pure surcharge on every token of the prefix.
 * A stage that must call tools comes back through the loop with the same system
 * prompt and the same tool definitions in front of it, and every turn after the
 * first reads what the first one wrote.
 *
 * Hence the `auto` rule: cache when the stage's own contract says it has to use
 * tools. That is the one declaration in `.studio/` that predicts a second turn
 * before the first one has happened — tools merely being *available* does not,
 * which is exactly the case that was paying for caches nothing ever read.
 */

import type { OutputContract, PromptCacheMode } from '@studio-foundation/contracts';

export interface PromptCacheDecision {
  /** Whether the stage's contract obliges it to call tools (so the loop will run again). */
  hasTools: boolean;
  contract?: OutputContract;
  mode?: PromptCacheMode;
}

/**
 * True when the contract cannot be satisfied without at least one tool call —
 * a floor on `minimum`, or a named tool/tool group the agent has to reach for.
 */
export function contractRequiresToolCalls(contract?: OutputContract): boolean {
  const requirements = contract?.tool_calls;
  if (!requirements) return false;
  if ((requirements.minimum ?? 0) > 0) return true;
  if ((requirements.required_tools?.length ?? 0) > 0) return true;
  return (requirements.required_tool_groups?.length ?? 0) > 0;
}

/** Resolve the agent's `prompt_cache` setting against what the stage actually looks like. */
export function shouldCachePrompt({ hasTools, contract, mode }: PromptCacheDecision): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  // auto (and anything unset): a prefix no second turn can read is not worth writing.
  return hasTools && contractRequiresToolCalls(contract);
}
