import type { PIISpan } from './types.js';
import { matchPII } from './detection/regex-matcher.js';

/**
 * Detect PII spans in text.
 * Returns non-overlapping spans sorted by position.
 *
 * Thin adapter over the shared regex-matcher internal: the matcher owns the
 * patterns, the canonical type vocabulary, and overlap resolution (positions
 * only). The value is reconstructed HERE — never inside the internal. PIIType
 * is a subset of PIICategory, so the type assignment is direct.
 */
export function detectPII(text: string): PIISpan[] {
  return matchPII(text).map(({ start, end, type }) => ({
    start,
    end,
    category: type,
    value: text.slice(start, end),
  }));
}
