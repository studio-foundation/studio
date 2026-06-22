import { describe, it, expect } from 'vitest';
import { RegexDetector } from '../src/detection/regex-detector.js';
import type { Span } from '../src/detection/provider.js';

describe('RegexDetector', () => {
  const detector = new RegexDetector();

  it('detect() returns a Promise<Span[]>', async () => {
    const result = detector.detect('Contact mc@acme.com');
    expect(result).toBeInstanceOf(Promise);
    const spans = await result;
    expect(Array.isArray(spans)).toBe(true);
  });

  it('returns correct start/end/type for each supported type', async () => {
    const text = 'Email mc@acme.com call 514-555-1234 ssn 123-45-6789 card 4111111111111111 Dear John Smith';
    const spans = await detector.detect(text);
    const types = new Set(spans.map(s => s.type));
    expect(types.has('email')).toBe(true);
    expect(types.has('phone')).toBe(true);
    expect(types.has('ssn')).toBe(true);
    expect(types.has('credit_card')).toBe(true);
    expect(types.has('person')).toBe(true);
    for (const s of spans) {
      expect(text.slice(s.start, s.end).length).toBe(s.end - s.start);
    }
  });

  it('spans carry NO value field — positions only', async () => {
    const spans = await detector.detect('Contact mc@acme.com');
    for (const s of spans) {
      expect(Object.keys(s).sort()).toEqual(['end', 'start', 'type']);
      expect((s as Record<string, unknown>).value).toBeUndefined();
    }
  });

  it('detects a French-salutation name end to end', async () => {
    const text = 'Bonjour Marie Tremblay,';
    const spans = await detector.detect(text);
    const person = spans.find((s: Span) => s.type === 'person');
    expect(person).toBeDefined();
    expect(text.slice(person!.start, person!.end)).toBe('Marie Tremblay');
  });
});
