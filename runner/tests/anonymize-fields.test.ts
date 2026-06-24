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

describe('AnonymizationMiddleware.anonymizeFields scope', () => {
  it('AC1/AC3: with a scope, only scoped fields are tokenized; others stay cleartext', async () => {
    const mw = new AnonymizationMiddleware();
    const out = await mw.anonymizeFields(
      { from: 'mc@acme.com', body: 'Reply to jane@acme.com' },
      ['body'],
    );
    // body is in scope → tokenized
    expect(out.body).toContain('EMAIL_1');
    expect(out.body).not.toContain('jane@acme.com');
    // from is out of scope → byte-for-byte cleartext
    expect(out.from).toBe('mc@acme.com');
  });

  it('AC4: same PII in a scoped AND an unscoped field — full deanonymize round-trip', async () => {
    const mw = new AnonymizationMiddleware();
    // mc@acme.com appears in both `from` (out of scope) and `body` (in scope)
    const out = await mw.anonymizeFields(
      { from: 'mc@acme.com', body: 'Forward to mc@acme.com' },
      ['body'],
    );

    // (1) token in the scoped field, real value in the unscoped field
    expect(out.body).toContain('EMAIL_1');
    expect(out.body).not.toContain('mc@acme.com');
    expect(out.from).toBe('mc@acme.com');

    // (2) a simulated LLM response that references the token reconstructs the real value
    const llmResponse = 'Sent the message to EMAIL_1 as requested.';
    expect(mw.deanonymize(llmResponse)).toBe('Sent the message to mc@acme.com as requested.');

    // (3) the cleartext occurrence that passed through the unscoped field did not
    // pollute the keymap: exactly one mapping, EMAIL_1 → mc@acme.com, no EMAIL_2
    const keymap = mw.getKeymap();
    expect(keymap).toEqual({ EMAIL_1: 'mc@acme.com' });
  });

  it('scope undefined → all fields anonymized (fail-safe default)', async () => {
    const mw = new AnonymizationMiddleware();
    const out = await mw.anonymizeFields({ from: 'mc@acme.com', body: 'Hi jane@acme.com' });
    expect(out.from).not.toContain('mc@acme.com');
    expect(out.body).not.toContain('jane@acme.com');
  });

  it('scope [] → nothing anonymized, every field cleartext', async () => {
    const mw = new AnonymizationMiddleware();
    const out = await mw.anonymizeFields({ from: 'mc@acme.com', body: 'Hi jane@acme.com' }, []);
    expect(out).toEqual({ from: 'mc@acme.com', body: 'Hi jane@acme.com' });
    expect(mw.getKeymap()).toEqual({});
  });

  it('unknown names in scope are ignored (no-op, no crash)', async () => {
    const mw = new AnonymizationMiddleware();
    const out = await mw.anonymizeFields({ body: 'Hi jane@acme.com' }, ['nonexistent']);
    // 'body' not in scope → cleartext; 'nonexistent' simply matches nothing
    expect(out).toEqual({ body: 'Hi jane@acme.com' });
  });
});
