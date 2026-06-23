import { anonymize, anonymizeWithProvider, deanonymize, RegexDetector } from '@studio-foundation/anonymizer';
import type { AnonymizerOptions, DetectionProvider } from '@studio-foundation/anonymizer';

/**
 * Stateful middleware that anonymizes text before sending to LLM
 * and deanonymizes text after receiving from LLM.
 * Accumulates the keymap across calls for cross-call consistency.
 */
export class AnonymizationMiddleware {
  private keymap: Record<string, string> = {};
  private options?: Omit<AnonymizerOptions, 'seedKeymap'>;
  private detector: DetectionProvider;

  constructor(options?: Omit<AnonymizerOptions, 'seedKeymap'>, detector?: DetectionProvider) {
    this.options = options;
    // Default to the in-process regex detector. A run can inject a different
    // DetectionProvider (e.g. a future NER/Presidio provider) without the
    // middleware knowing anything about detection internals.
    this.detector = detector ?? new RegexDetector();
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
   * Anonymize named input fields independently, BEFORE prompt assembly. Each
   * field is detected + tokenized through the injected DetectionProvider, all
   * sharing this instance's run-level keymap — so a PII value appearing in two
   * fields receives the SAME token. Field names are opaque; only values are
   * inspected. Async because DetectionProvider.detect is async.
   */
  async anonymizeFields(fields: Record<string, string>): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(fields)) {
      const result = await anonymizeWithProvider(value, this.detector, {
        ...this.options,
        seedKeymap: this.keymap,
      });
      // Carry the accumulated keymap forward so the next field reuses tokens.
      this.keymap = result.keymap;
      out[name] = result.text;
    }
    return out;
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
