import { describe, it, expect } from 'vitest';
import { matchPII, resolveByPriority } from '../src/detection/regex-matcher.js';

describe('matchPII — format types', () => {
  it('detects email with correct bounds and type', () => {
    const text = 'Contact mc@acme.com for info';
    const spans = matchPII(text);
    const email = spans.find(s => s.type === 'email');
    expect(email).toBeDefined();
    expect(text.slice(email!.start, email!.end)).toBe('mc@acme.com');
  });

  it('detects phone, ssn, credit_card', () => {
    expect(matchPII('Call 514-555-1234').some(s => s.type === 'phone')).toBe(true);
    expect(matchPII('SSN 123-45-6789').some(s => s.type === 'ssn')).toBe(true);
    expect(matchPII('Card 4111111111111111').some(s => s.type === 'credit_card')).toBe(true);
  });

  it('returns empty array for clean text', () => {
    expect(matchPII('a normal sentence')).toEqual([]);
  });

  it('returns spans sorted by start', () => {
    const spans = matchPII('Email mc@acme.com then 514-555-1234');
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i - 1].start).toBeLessThanOrEqual(spans[i].start);
    }
  });
});

describe('resolveByPriority — overlap rule', () => {
  it('credit_card outranks ssn on a shared range', () => {
    const out = resolveByPriority([
      { start: 0, end: 19, type: 'ssn' },
      { start: 0, end: 19, type: 'credit_card' },
    ]);
    expect(out).toEqual([{ start: 0, end: 19, type: 'credit_card' }]);
  });

  it('drops a lower-priority span whose interior overlaps (true interval, not start-only)', () => {
    // Winner occupies [10,26). Loser starts at 5 (FREE) but its interior 10..14 collides.
    // A start-only check would wrongly keep the loser; the interval check drops it.
    const out = resolveByPriority([
      { start: 10, end: 26, type: 'credit_card' },
      { start: 5, end: 15, type: 'phone' },
    ]);
    expect(out).toEqual([{ start: 10, end: 26, type: 'credit_card' }]);
  });

  it('keeps half-open adjacent spans (end is exclusive)', () => {
    const out = resolveByPriority([
      { start: 0, end: 5, type: 'email' },
      { start: 5, end: 10, type: 'phone' },
    ]);
    expect(out.length).toBe(2);
  });
});

describe('matchPII — person (FR + EN salutations)', () => {
  it('detects an English-salutation name', () => {
    const text = 'Dear John Smith,';
    const p = matchPII(text).find(s => s.type === 'person');
    expect(p).toBeDefined();
    expect(text.slice(p!.start, p!.end)).toBe('John Smith');
  });

  it('detects a French-salutation name (deployment prerequisite)', () => {
    const text = 'Bonjour Marie Tremblay,';
    const p = matchPII(text).find(s => s.type === 'person');
    expect(p).toBeDefined();
    expect(text.slice(p!.start, p!.end)).toBe('Marie Tremblay');
  });

  it('handles accented surnames after French salutations', () => {
    const text = 'Madame Jean Côté';
    const p = matchPII(text).find(s => s.type === 'person');
    expect(p).toBeDefined();
    expect(text.slice(p!.start, p!.end)).toBe('Jean Côté');
  });

  it('detects M. / Mme abbreviation salutations', () => {
    expect(matchPII('M. Dupont').some(s => s.type === 'person')).toBe(true);
    expect(matchPII('Mme Gagnon').some(s => s.type === 'person')).toBe(true);
  });

  it('does NOT match a word merely ending in m before a period (M. negative guard)', () => {
    // "forum." ends in "m." but "m" is not a standalone token (preceded by "u"),
    // so the M. salutation must not fire and "Trois" must not become a person.
    const text = 'Le forum. Trois équipes inscrites';
    expect(matchPII(text).some(s => s.type === 'person')).toBe(false);
  });

  it('person yields to a higher-priority formatted span on overlap', () => {
    // person is lowest priority; if a formatted type claims the range, person loses.
    const out = resolveByPriority([
      { start: 5, end: 16, type: 'person' },
      { start: 5, end: 16, type: 'email' },
    ]);
    expect(out).toEqual([{ start: 5, end: 16, type: 'email' }]);
  });
});
