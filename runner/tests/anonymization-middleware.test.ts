import { describe, it, expect } from 'vitest';
import { AnonymizationMiddleware } from '../src/middleware/anonymization.js';

describe('AnonymizationMiddleware', () => {
  it('anonymizes text containing PII', () => {
    const mw = new AnonymizationMiddleware();
    const result = mw.anonymize('Contact mc@acme.com');
    expect(result).not.toContain('mc@acme.com');
    expect(result).toContain('EMAIL_1');
  });

  it('deanonymizes using accumulated keymap', () => {
    const mw = new AnonymizationMiddleware();
    const anon = mw.anonymize('Contact mc@acme.com');
    const restored = mw.deanonymize(anon);
    expect(restored).toBe('Contact mc@acme.com');
  });

  it('is consistent across multiple calls (same email = same token)', () => {
    const mw = new AnonymizationMiddleware();
    const first = mw.anonymize('Email mc@acme.com here');
    const second = mw.anonymize('Also mc@acme.com again');
    expect(first).toContain('EMAIL_1');
    expect(second).toContain('EMAIL_1');
    // Verify deanonymize restores both
    expect(mw.deanonymize(first)).toBe('Email mc@acme.com here');
    expect(mw.deanonymize(second)).toBe('Also mc@acme.com again');
  });

  it('accumulates keymap across calls', () => {
    const mw = new AnonymizationMiddleware();
    mw.anonymize('Email mc@acme.com');
    mw.anonymize('Phone 514-555-1234');
    const keymap = mw.getKeymap();
    expect(keymap['EMAIL_1']).toBe('mc@acme.com');
    expect(keymap['PHONE_1']).toBe('514-555-1234');
  });

  it('handles JSON round-trip', () => {
    const mw = new AnonymizationMiddleware();
    const obj = { email: 'mc@acme.com', message: 'hello' };
    const anonStr = mw.anonymize(JSON.stringify(obj));
    const restored = JSON.parse(mw.deanonymize(anonStr));
    expect(restored.email).toBe('mc@acme.com');
  });

  it('passes through text with no PII unchanged', () => {
    const mw = new AnonymizationMiddleware();
    const text = 'Calculate 2 + 2 = 4';
    expect(mw.anonymize(text)).toBe(text);
    expect(mw.deanonymize(text)).toBe(text);
  });

  it('new email in second call gets EMAIL_2 (not EMAIL_1 again)', () => {
    const mw = new AnonymizationMiddleware();
    mw.anonymize('Email mc@acme.com');
    const second = mw.anonymize('Other other@example.com');
    expect(second).toContain('EMAIL_2');
    expect(mw.getKeymap()['EMAIL_2']).toBe('other@example.com');
  });
});
