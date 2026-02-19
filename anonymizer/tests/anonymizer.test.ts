import { describe, it, expect } from 'vitest';
import { anonymize, deanonymize } from '../src/index.js';

describe('anonymize', () => {
  it('replaces emails with tokens', () => {
    const result = anonymize('Send to mc@acme.com please');
    expect(result.text).not.toContain('mc@acme.com');
    expect(result.text).toContain('EMAIL_1');
    expect(result.keymap['EMAIL_1']).toBe('mc@acme.com');
  });

  it('replaces the same PII twice in one call with the same token', () => {
    const result = anonymize('Email mc@acme.com then mc@acme.com again');
    const emails = result.text.match(/EMAIL_\d+/g) ?? [];
    expect(emails.every(e => e === 'EMAIL_1')).toBe(true);
    expect(result.text.split('EMAIL_1').length - 1).toBe(2);
  });

  it('assigns different tokens to different PII of same category', () => {
    const result = anonymize('Email mc@acme.com and other@example.com');
    expect(result.keymap['EMAIL_1']).toBeDefined();
    expect(result.keymap['EMAIL_2']).toBeDefined();
    expect(result.keymap['EMAIL_1']).not.toBe(result.keymap['EMAIL_2']);
  });

  it('handles multiple categories', () => {
    const result = anonymize('Email: mc@acme.com, Phone: 514-555-1234');
    expect(Object.keys(result.keymap).length).toBeGreaterThanOrEqual(2);
    expect(result.text).not.toContain('mc@acme.com');
    expect(result.text).not.toContain('514-555-1234');
  });

  it('returns unchanged text when no PII found', () => {
    const result = anonymize('This text has no sensitive data');
    expect(result.text).toBe('This text has no sensitive data');
    expect(result.keymap).toEqual({});
  });

  it('seedKeymap ensures cross-call consistency', () => {
    // First call establishes EMAIL_1 for mc@acme.com
    const first = anonymize('mc@acme.com');
    // Second call with the keymap as seed
    const second = anonymize('other@example.com and mc@acme.com', {
      seedKeymap: first.keymap,
    });
    // mc@acme.com should still be EMAIL_1 (from seed)
    expect(second.keymap['EMAIL_1']).toBe('mc@acme.com');
    // other@example.com gets EMAIL_2
    expect(second.keymap['EMAIL_2']).toBe('other@example.com');
  });
});

describe('deanonymize', () => {
  it('restores original values from keymap', () => {
    const { text, keymap } = anonymize('Send to mc@acme.com please');
    const restored = deanonymize(text, keymap);
    expect(restored).toBe('Send to mc@acme.com please');
  });

  it('leaves unknown tokens unchanged', () => {
    const result = deanonymize('Hello PERSON_99', {});
    expect(result).toBe('Hello PERSON_99');
  });

  it('restores multiple tokens', () => {
    const keymap = { 'EMAIL_1': 'a@b.com', 'PERSON_1': 'Alice' };
    const restored = deanonymize('EMAIL_1 sent by PERSON_1', keymap);
    expect(restored).toBe('a@b.com sent by Alice');
  });

  it('round-trip: anonymize then deanonymize restores original', () => {
    const original = 'Email: mc@acme.com, Phone: 514-555-1234';
    const { text, keymap } = anonymize(original);
    const restored = deanonymize(text, keymap);
    expect(restored).toBe(original);
  });
});
