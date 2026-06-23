import { describe, it, expect } from 'vitest';
import { anonymizeWithProvider, deanonymize, RegexDetector } from '../src/index.js';
import type { DetectionProvider, Span } from '../src/index.js';

/** A provider that returns a type outside the six built-in PIICategory values. */
class OrgDetector implements DetectionProvider {
  async detect(text: string): Promise<Span[]> {
    const spans: Span[] = [];
    for (const name of ['Acme Corp', 'Globex']) {
      const start = text.indexOf(name);
      if (start >= 0) spans.push({ start, end: start + name.length, type: 'organization' });
    }
    return spans;
  }
}

describe('anonymizeWithProvider', () => {
  it('detects PII via the injected provider and tokenizes it', async () => {
    const result = await anonymizeWithProvider('Email mc@acme.com here', new RegexDetector());
    expect(result.text).not.toContain('mc@acme.com');
    expect(result.text).toContain('EMAIL_1');
    expect(result.keymap['EMAIL_1']).toBe('mc@acme.com');
  });

  it('reuses tokens from a seeded keymap (cross-call consistency)', async () => {
    const seedKeymap = { EMAIL_1: 'mc@acme.com' };
    const result = await anonymizeWithProvider('Reply to mc@acme.com', new RegexDetector(), { seedKeymap });
    expect(result.text).toContain('EMAIL_1');
    expect(result.text).not.toContain('EMAIL_2');
    expect(result.keymap['EMAIL_1']).toBe('mc@acme.com');
  });

  it('returns text unchanged when the provider finds no PII', async () => {
    const result = await anonymizeWithProvider('Calculate 2 + 2 = 4', new RegexDetector());
    expect(result.text).toBe('Calculate 2 + 2 = 4');
  });

  it('tokenizes an out-of-vocabulary provider type cleanly and reversibly', async () => {
    const result = await anonymizeWithProvider('Acme Corp acquired Globex', new OrgDetector());
    // Distinct entities → distinct, well-formed tokens (never undefined_N, no collision)
    expect(result.text).not.toContain('undefined');
    const tokens = result.text.match(/ORGANIZATION_\d+/g) ?? [];
    expect(new Set(tokens).size).toBe(2);
    expect(deanonymize(result.text, result.keymap)).toBe('Acme Corp acquired Globex');
  });
});
