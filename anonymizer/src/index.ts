import { detectPII } from './detector.js';
import { Tokenizer } from './tokenizer.js';
import type { PIIDetectionResult, AnonymizerOptions } from './types.js';

export type { PIICategory, PIIDetectionResult, AnonymizerOptions } from './types.js';
export { Tokenizer } from './tokenizer.js';

/**
 * Anonymize PII in text. Returns anonymized text + keymap (token → original).
 * Same PII value always gets the same token within a call.
 * Pass seedKeymap to maintain consistency across multiple calls.
 */
export function anonymize(text: string, options?: AnonymizerOptions): PIIDetectionResult {
  const spans = detectPII(text);
  const filtered = options?.categories
    ? spans.filter(s => options.categories!.includes(s.category))
    : spans;

  const tokenizer = new Tokenizer();
  // Seed from existing keymap for cross-call consistency
  if (options?.seedKeymap && Object.keys(options.seedKeymap).length > 0) {
    tokenizer.loadKeymap(options.seedKeymap);
  }

  if (filtered.length === 0) {
    return { text, keymap: tokenizer.getKeymap() };
  }

  // Deduplicate: keep only the first occurrence of each unique value
  // so that repeated values are replaced with the same token.
  const seenValues = new Set<string>();
  const deduped = filtered.filter(span => {
    if (seenValues.has(span.value)) return true; // keep for replacement, token will be reused
    seenValues.add(span.value);
    return true;
  });

  // Replace spans from right to left to preserve character positions
  const sortedDesc = [...deduped].sort((a, b) => b.start - a.start);
  let result = text;
  for (const span of sortedDesc) {
    const token = tokenizer.tokenize(span.value, span.category);
    result = result.slice(0, span.start) + token + result.slice(span.end);
  }

  return { text: result, keymap: tokenizer.getKeymap() };
}

/**
 * Restore original PII values from keymap.
 * Tokens not in the keymap are left unchanged.
 */
export function deanonymize(text: string, keymap: Record<string, string>): string {
  let result = text;
  for (const [token, original] of Object.entries(keymap)) {
    result = result.replaceAll(token, original);
  }
  return result;
}
