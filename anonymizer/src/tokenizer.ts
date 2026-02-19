import type { PIICategory } from './types.js';

const CATEGORY_PREFIX: Record<PIICategory, string> = {
  person: 'PERSON',
  email: 'EMAIL',
  phone: 'PHONE',
  address: 'ADDRESS',
  ssn: 'SSN',
  credit_card: 'CREDIT_CARD',
};

export class Tokenizer {
  // original value → token
  private inverse = new Map<string, string>();
  // token → original value
  private keymap = new Map<string, string>();
  // category → counter
  private counters = new Map<PIICategory, number>();

  /**
   * Get or create a consistent sequential token for a PII value.
   */
  tokenize(value: string, category: PIICategory): string {
    const existing = this.inverse.get(value);
    if (existing) return existing;

    const counter = (this.counters.get(category) ?? 0) + 1;
    this.counters.set(category, counter);

    const prefix = CATEGORY_PREFIX[category];
    const token = `${prefix}_${counter}`;

    this.inverse.set(value, token);
    this.keymap.set(token, value);
    return token;
  }

  getKeymap(): Record<string, string> {
    return Object.fromEntries(this.keymap);
  }

  /**
   * Load an existing keymap (for cross-stage continuity).
   * Populates inverse map so existing tokens are reused.
   */
  loadKeymap(keymap: Record<string, string>): void {
    for (const [token, value] of Object.entries(keymap)) {
      this.keymap.set(token, value);
      this.inverse.set(value, token);
      // Restore counter state from token name (e.g. PERSON_3 → counter = 3)
      const match = token.match(/^([A-Z_]+)_(\d+)$/);
      if (match) {
        const cat = Object.entries(CATEGORY_PREFIX).find(([, p]) => p === match[1])?.[0] as PIICategory | undefined;
        if (cat) {
          const n = parseInt(match[2], 10);
          if ((this.counters.get(cat) ?? 0) < n) {
            this.counters.set(cat, n);
          }
        }
      }
    }
  }
}
