// Reading and rendering the token counts a run recorded.
//
// Two JSONL shapes exist in the wild. Runs written before per-call usage landed
// carry `tokens: { prompt, completion, total }`; runs written since carry the
// full `TokenUsage` (cache split + per-model breakdown). `studio status` and
// `studio replay` both read historical run files, so both shapes are accepted —
// a run log does not become unreadable because Studio was upgraded.

import type { ModelTokenUsage, TokenUsage } from '@studio-foundation/contracts';

interface LegacyTokens {
  prompt: number;
  completion: number;
  total: number;
}

function isLegacy(value: Record<string, unknown>): boolean {
  return typeof value.total === 'number' && value.total_tokens === undefined;
}

/** Parse a `tokens` field off a run JSONL line, in either recorded shape. */
export function parseLoggedUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;

  if (isLegacy(raw)) {
    const legacy = raw as unknown as LegacyTokens;
    return {
      prompt_tokens: legacy.prompt ?? 0,
      completion_tokens: legacy.completion ?? 0,
      total_tokens: legacy.total ?? 0,
    };
  }

  if (typeof raw.total_tokens !== 'number') return undefined;
  return raw as unknown as TokenUsage;
}

/** 947 → "947", 13512 → "13.5k", 1_240_000 → "1.24M". */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) < 1000) return String(Math.round(n));
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * "145.2k tokens (12.1k in · 3.4k out · 128k cached · 1.7k cache-write)" —
 * the components are listed because they are billed at different rates, so the
 * total alone does not tell you what a run cost.
 */
export function formatUsageSummary(usage: ModelTokenUsage): string {
  const parts = [`${formatTokenCount(usage.prompt_tokens)} in`, `${formatTokenCount(usage.completion_tokens)} out`];
  if (usage.cached_input_tokens) parts.push(`${formatTokenCount(usage.cached_input_tokens)} cached`);
  if (usage.cache_creation_tokens) parts.push(`${formatTokenCount(usage.cache_creation_tokens)} cache-write`);
  return `${formatTokenCount(usage.total_tokens)} tokens (${parts.join(' · ')})`;
}

/** Per-model rows, heaviest first — the breakdown a cost review starts from. */
export function usageByModel(usage: TokenUsage): Array<[string, ModelTokenUsage]> {
  if (!usage.by_model) return [];
  return Object.entries(usage.by_model).sort((a, b) => b[1].total_tokens - a[1].total_tokens);
}
