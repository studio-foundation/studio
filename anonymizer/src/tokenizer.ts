export class Tokenizer {
  // original value → token
  private inverse = new Map<string, string>();
  // token → original value
  private keymap = new Map<string, string>();
  // category (lowercased) → counter
  private counters = new Map<string, number>();

  /**
   * Get or create a consistent sequential token for a PII value.
   *
   * `category` is a free string: the built-in detector emits the six PIICategory
   * values, but a pluggable DetectionProvider (STU-397) may return its own
   * vocabulary (e.g. "organization", "iban"). The token prefix is the category
   * uppercased — for the built-in categories that is exactly the old fixed
   * mapping (person → PERSON, credit_card → CREDIT_CARD), so existing tokens are
   * unchanged — and the counter is keyed by the lowercased category so distinct
   * types never collide on a single prefix.
   */
  tokenize(value: string, category: string): string {
    const existing = this.inverse.get(value);
    if (existing) return existing;

    const key = category.toLowerCase();
    const counter = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, counter);

    const token = `${category.toUpperCase()}_${counter}`;

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
      // Restore counter state from token name (e.g. PERSON_3 → counter = 3).
      // The prefix lowercased is the counter key, mirroring tokenize().
      const match = token.match(/^([A-Z_]+)_(\d+)$/);
      if (match) {
        const key = match[1].toLowerCase();
        const n = parseInt(match[2], 10);
        if ((this.counters.get(key) ?? 0) < n) {
          this.counters.set(key, n);
        }
      }
    }
  }
}
