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
