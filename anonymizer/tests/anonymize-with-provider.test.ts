import { describe, it, expect } from 'vitest';
import { anonymizeWithProvider, RegexDetector } from '../src/index.js';

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
});
