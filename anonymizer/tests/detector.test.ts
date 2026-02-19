import { describe, it, expect } from 'vitest';
import { detectPII } from '../src/detector.js';

describe('detectPII', () => {
  it('detects email addresses', () => {
    const spans = detectPII('Contact mc@acme.com for info');
    const emails = spans.filter(s => s.category === 'email');
    expect(emails.length).toBeGreaterThan(0);
    expect(emails[0].value).toBe('mc@acme.com');
  });

  it('detects phone numbers', () => {
    const spans = detectPII('Call 514-555-1234 now');
    const phones = spans.filter(s => s.category === 'phone');
    expect(phones.length).toBeGreaterThan(0);
  });

  it('detects credit card numbers', () => {
    const spans = detectPII('Card number: 4111111111111111');
    const cards = spans.filter(s => s.category === 'credit_card');
    expect(cards.length).toBeGreaterThan(0);
  });

  it('returns empty array for clean text', () => {
    const spans = detectPII('This is a normal sentence without PII');
    expect(spans).toEqual([]);
  });

  it('returns spans with correct position bounds', () => {
    const text = 'Email: mc@acme.com here';
    const spans = detectPII(text);
    const email = spans.find(s => s.category === 'email');
    expect(email).toBeDefined();
    expect(text.slice(email!.start, email!.end)).toBe(email!.value);
  });

  it('does not return overlapping spans', () => {
    const text = 'Email mc@acme.com and phone 514-555-1234';
    const spans = detectPII(text);
    // Verify no two spans overlap
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        expect(spans[i].end <= spans[j].start || spans[j].end <= spans[i].start).toBe(true);
      }
    }
  });
});
