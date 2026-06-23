import { describe, it, expect, beforeEach } from 'vitest';
import { Tokenizer } from '../src/tokenizer.js';

describe('Tokenizer', () => {
  let tokenizer: Tokenizer;

  beforeEach(() => {
    tokenizer = new Tokenizer();
  });

  it('assigns sequential tokens per category', () => {
    const t1 = tokenizer.tokenize('Marie-Claire', 'person');
    const t2 = tokenizer.tokenize('Jean-François', 'person');
    const t3 = tokenizer.tokenize('mc@acme.com', 'email');
    expect(t1).toBe('PERSON_1');
    expect(t2).toBe('PERSON_2');
    expect(t3).toBe('EMAIL_1');
  });

  it('returns the same token for the same value', () => {
    const t1 = tokenizer.tokenize('Marie-Claire', 'person');
    const t2 = tokenizer.tokenize('Marie-Claire', 'person');
    expect(t1).toBe(t2);
    expect(t1).toBe('PERSON_1');
  });

  it('builds keymap correctly', () => {
    tokenizer.tokenize('Marie-Claire', 'person');
    tokenizer.tokenize('mc@acme.com', 'email');
    const keymap = tokenizer.getKeymap();
    expect(keymap).toEqual({
      'PERSON_1': 'Marie-Claire',
      'EMAIL_1': 'mc@acme.com',
    });
  });

  it('handles all supported categories', () => {
    const categories = ['person', 'email', 'phone', 'address', 'ssn', 'credit_card'] as const;
    for (const cat of categories) {
      const token = tokenizer.tokenize('test-value', cat);
      expect(token).toMatch(/^[A-Z_]+_1$/);
    }
  });

  it('derives a clean uppercase prefix for an out-of-vocabulary category', () => {
    // A future DetectionProvider may return types outside the 6 built-ins
    // (Span.type is a free string by design). They must still tokenize cleanly,
    // never as `undefined_1`.
    const t = tokenizer.tokenize('Acme Corp', 'organization');
    expect(t).toBe('ORGANIZATION_1');
    expect(tokenizer.getKeymap()).toEqual({ ORGANIZATION_1: 'Acme Corp' });
  });

  it('does not collide two distinct out-of-vocabulary categories', () => {
    const a = tokenizer.tokenize('Acme Corp', 'organization');
    const b = tokenizer.tokenize('FR76 1234', 'iban');
    expect(a).toBe('ORGANIZATION_1');
    expect(b).toBe('IBAN_1');
    expect(tokenizer.getKeymap()).toEqual({
      ORGANIZATION_1: 'Acme Corp',
      IBAN_1: 'FR76 1234',
    });
  });

  it('loadKeymap restores counters for out-of-vocabulary categories', () => {
    tokenizer.loadKeymap({ ORGANIZATION_1: 'Acme Corp' });
    const next = tokenizer.tokenize('Globex', 'organization');
    expect(next).toBe('ORGANIZATION_2'); // counter restored, no collision
    expect(tokenizer.tokenize('Acme Corp', 'organization')).toBe('ORGANIZATION_1');
  });

  it('loadKeymap restores state for cross-call consistency', () => {
    // Simulate loading a pre-existing keymap
    tokenizer.loadKeymap({ 'PERSON_1': 'Alice', 'EMAIL_1': 'alice@example.com' });
    // New tokenization should continue from counter 1
    const t = tokenizer.tokenize('Bob', 'person');
    expect(t).toBe('PERSON_2');
    // Existing value should reuse its token
    const tAlice = tokenizer.tokenize('Alice', 'person');
    expect(tAlice).toBe('PERSON_1');
  });
});
