import type { DetectionProvider, Span } from './provider.js';
import { matchPII } from './regex-matcher.js';

/**
 * Base in-process detector. Covers the types where regex is reliable
 * (formatted identifiers): email, phone, ssn, credit_card, and salutation-based
 * person (FR + EN).
 *
 * address is intentionally delegated to a future NER detector — see PRIORITY in
 * regex-matcher.ts. Do NOT add an address regex here.
 */
export class RegexDetector implements DetectionProvider {
  async detect(text: string): Promise<Span[]> {
    return matchPII(text).map(({ start, end, type }) => ({ start, end, type }));
  }
}
