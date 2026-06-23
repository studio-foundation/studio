import { describe, it, expect } from 'vitest';
import { AnonymizationMiddleware } from '../src/middleware/anonymization.js';

describe('AnonymizationMiddleware.anonymizeFields', () => {
  it('anonymizes each field independently, structure preserved', async () => {
    const mw = new AnonymizationMiddleware();
    const out = await mw.anonymizeFields({
      from: 'mc@acme.com',
      body: 'Please reply to mc@acme.com',
    });

    expect(out.from).not.toContain('mc@acme.com');
    expect(out.body).not.toContain('mc@acme.com');
    expect(Object.keys(out)).toEqual(['from', 'body']);
  });

  it('gives the SAME token to a PII value shared across two fields (run-level keymap)', async () => {
    const mw = new AnonymizationMiddleware();
    const out = await mw.anonymizeFields({
      from: 'mc@acme.com',
      body: 'Forward this to mc@acme.com today',
    });

    // Both fields reference the same email → same token, no EMAIL_2
    expect(out.from).toContain('EMAIL_1');
    expect(out.body).toContain('EMAIL_1');
    expect(out.body).not.toContain('EMAIL_2');
  });

  it('round-trips: deanonymize reconstructs the real values from the shared keymap', async () => {
    const mw = new AnonymizationMiddleware();
    const out = await mw.anonymizeFields({
      from: 'mc@acme.com',
      body: 'Reply to mc@acme.com',
    });

    expect(mw.deanonymize(out.from)).toBe('mc@acme.com');
    expect(mw.deanonymize(out.body)).toBe('Reply to mc@acme.com');
  });

  it('leaves fields without PII untouched', async () => {
    const mw = new AnonymizationMiddleware();
    const out = await mw.anonymizeFields({ subject: 'Quarterly report', count: '42' });
    expect(out).toEqual({ subject: 'Quarterly report', count: '42' });
  });

  it('shares the keymap with prior anonymize() calls on the same instance', async () => {
    const mw = new AnonymizationMiddleware();
    mw.anonymize('Seed mc@acme.com'); // EMAIL_1 → mc@acme.com
    const out = await mw.anonymizeFields({ body: 'Contact mc@acme.com' });
    expect(out.body).toContain('EMAIL_1');
    expect(out.body).not.toContain('EMAIL_2');
  });
});
