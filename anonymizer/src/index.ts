import { detectPII } from './detector.js';
import { Tokenizer } from './tokenizer.js';
import type { PIIDetectionResult, AnonymizerOptions } from './types.js';

export type { PIICategory, PIIDetectionResult, AnonymizerOptions } from './types.js';
export { Tokenizer } from './tokenizer.js';
export { RegexDetector } from './detection/regex-detector.js';
export type { DetectionProvider, Span } from './detection/provider.js';

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

  // Replace spans from right to left to preserve character positions
  const sortedDesc = [...filtered].sort((a, b) => b.start - a.start);
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
  // Sort by token length descending so EMAIL_10 is replaced before EMAIL_1
  const sorted = Object.entries(keymap).sort((a, b) => b[0].length - a[0].length);
  for (const [token, original] of sorted) {
    result = result.replaceAll(token, original);
  }
  return result;
}
