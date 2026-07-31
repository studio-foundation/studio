// Token accounting — the shape every provider reports and every consumer sums.
//
// One type, three hops: a provider fills it per LLM call, the runner accumulates
// it across the turns of one agent run, the engine stamps it on the stage and the
// CLI writes it to the run JSONL. Measuring what a run cost is then a `jq` pass
// over `.studio/runs/<run>.jsonl`, not a correlation of provider session files
// against stage timestamps.

/**
 * Token counts for a single model.
 *
 * The four input/output fields are disjoint, because each is billed at its own
 * rate — a run that reads 200k tokens from cache and one that sends 200k fresh
 * differ by an order of magnitude in cost, and a single `prompt_tokens` number
 * cannot tell them apart. Providers report the split differently (Anthropic
 * excludes cache counts from its input total, OpenAI includes them); every
 * Studio provider normalizes to the definitions below.
 */
export interface ModelTokenUsage {
  /** Input tokens billed at full rate — cache reads and writes excluded. */
  prompt_tokens: number;
  /** Output tokens generated. */
  completion_tokens: number;
  /** Every token the call consumed: prompt + cached + cache-creation + completion. */
  total_tokens: number;
  /** Input tokens served from the provider's prompt cache (billed at a discount). */
  cached_input_tokens?: number;
  /** Input tokens written to the provider's prompt cache (billed at a premium). */
  cache_creation_tokens?: number;
}

export interface TokenUsage extends ModelTokenUsage {
  /**
   * Per-model split of the same counts. One entry for an ordinary call; several
   * when a single call spans models (the claude CLI reports one per model it
   * used, subagents included). The top-level counts are always the sum of these.
   */
  by_model?: Record<string, ModelTokenUsage>;
}

/** A zeroed accumulator. */
export function emptyTokenUsage(): TokenUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

/**
 * Attach a model name to a set of counts, so the by_model split survives every
 * later merge. Providers that know which model answered call this instead of
 * building the map by hand.
 */
export function withModel(model: string | undefined, counts: ModelTokenUsage): TokenUsage {
  if (!model) return { ...counts };
  return { ...counts, by_model: { [model]: { ...counts } } };
}

function addInto(target: ModelTokenUsage, add: ModelTokenUsage): void {
  target.prompt_tokens += add.prompt_tokens;
  target.completion_tokens += add.completion_tokens;
  target.total_tokens += add.total_tokens;
  if (add.cached_input_tokens !== undefined) {
    target.cached_input_tokens = (target.cached_input_tokens ?? 0) + add.cached_input_tokens;
  }
  if (add.cache_creation_tokens !== undefined) {
    target.cache_creation_tokens = (target.cache_creation_tokens ?? 0) + add.cache_creation_tokens;
  }
}

/**
 * Sum `add` into `target` in place, merging the per-model split. `target` must be
 * an accumulator you own — `emptyTokenUsage()` or a clone.
 */
export function accumulateTokenUsage(target: TokenUsage, add: TokenUsage | undefined): TokenUsage {
  if (!add) return target;
  addInto(target, add);
  if (add.by_model) {
    target.by_model ??= {};
    for (const [model, counts] of Object.entries(add.by_model)) {
      const existing = target.by_model[model];
      if (existing) {
        addInto(existing, counts);
      } else {
        target.by_model[model] = { ...counts };
      }
    }
  }
  return target;
}

/**
 * Sum any number of usages. Returns undefined when nothing was reported, so an
 * absent usage stays absent instead of becoming a misleading row of zeros.
 */
export function sumTokenUsage(usages: Array<TokenUsage | undefined>): TokenUsage | undefined {
  const reported = usages.filter((u): u is TokenUsage => u !== undefined);
  if (reported.length === 0) return undefined;
  const total = emptyTokenUsage();
  for (const usage of reported) accumulateTokenUsage(total, usage);
  return total;
}
