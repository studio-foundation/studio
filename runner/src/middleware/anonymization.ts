import { anonymize, deanonymize } from '@studio-foundation/anonymizer';
import type { AnonymizerOptions } from '@studio-foundation/anonymizer';

/**
 * Stateful middleware that anonymizes text before sending to LLM
 * and deanonymizes text after receiving from LLM.
 * Accumulates the keymap across calls for cross-call consistency.
 */
export class AnonymizationMiddleware {
  private keymap: Record<string, string> = {};
  private options?: Omit<AnonymizerOptions, 'seedKeymap'>;

  constructor(options?: Omit<AnonymizerOptions, 'seedKeymap'>) {
    this.options = options;
  }

  /**
   * Anonymize text. Accumulated keymap grows with each call.
   * Same PII value always gets the same token (guaranteed by seedKeymap).
   */
  anonymize(text: string): string {
    const result = anonymize(text, { ...this.options, seedKeymap: this.keymap });
    // result.keymap is the full accumulated keymap (seed + new entries)
    this.keymap = result.keymap;
    return result.text;
  }

  /**
   * Deanonymize text using accumulated keymap.
   */
  deanonymize(text: string): string {
    return deanonymize(text, this.keymap);
  }

  getKeymap(): Record<string, string> {
    return { ...this.keymap };
  }
}
