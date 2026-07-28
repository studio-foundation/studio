import { describe, test, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import type { TriggerDef } from '@studio-foundation/contracts';
import { verifyHmac, matchesPayload, renderTemplate } from '../../src/triggers/webhook.js';

function trigger(when?: string[]): TriggerDef {
  return { name: 't', version: 1, pipeline: 'p', webhook: { ...(when ? { when } : {}) } };
}

describe('verifyHmac', () => {
  const body = Buffer.from('{"a":1}');
  const secret = 'shh';
  const good = createHmac('sha256', secret).update(body).digest('hex');

  test('accepts a matching signature', () => {
    expect(verifyHmac(body, good, secret)).toBe(true);
  });

  test('rejects a signature computed with another secret', () => {
    expect(verifyHmac(body, createHmac('sha256', 'other').update(body).digest('hex'), secret)).toBe(false);
  });

  test('rejects a signature of the wrong length instead of throwing', () => {
    expect(verifyHmac(body, 'abcd', secret)).toBe(false);
  });

  test('rejects a non-hex signature instead of throwing', () => {
    expect(verifyHmac(body, 'not-hex-at-all', secret)).toBe(false);
  });
});

describe('matchesPayload', () => {
  const payload = { type: 'Issue', action: 'update', data: { state: { name: 'In Progress' }, count: 3 } };

  test('matches when every condition holds', () => {
    expect(matchesPayload(trigger([
      'payload.type == "Issue"',
      'payload.action == "update"',
      'payload.data.state.name == "In Progress"',
    ]), payload)).toBe(true);
  });

  test('rejects when one condition fails', () => {
    expect(matchesPayload(trigger([
      'payload.type == "Issue"',
      'payload.data.state.name == "Done"',
    ]), payload)).toBe(false);
  });

  test('rejects a path that does not exist rather than passing', () => {
    expect(matchesPayload(trigger(['payload.data.missing.deep == "x"']), payload)).toBe(false);
  });

  test('compares numbers', () => {
    expect(matchesPayload(trigger(['payload.data.count > 2']), payload)).toBe(true);
    expect(matchesPayload(trigger(['payload.data.count > 5']), payload)).toBe(false);
  });

  test('matches every delivery when no conditions are declared', () => {
    expect(matchesPayload(trigger(), payload)).toBe(true);
  });
});

describe('renderTemplate', () => {
  const payload = { data: { id: 'abc', title: 'Ship it', tags: ['a', 'b'] } };

  test('interpolates payload references into a string', () => {
    expect(renderTemplate({ summary: '{{payload.data.id}} — {{payload.data.title}}' }, payload))
      .toEqual({ summary: 'abc — Ship it' });
  });

  test('keeps the native type when the string is exactly one reference', () => {
    expect(renderTemplate({ tags: '{{payload.data.tags}}' }, payload)).toEqual({ tags: ['a', 'b'] });
  });

  test('passes non-string values through untouched', () => {
    expect(renderTemplate({ criteria: [], n: 1 }, payload)).toEqual({ criteria: [], n: 1 });
  });

  test('renders an unreachable path as empty rather than failing', () => {
    expect(renderTemplate({ x: 'v={{payload.nope.deep}}' }, payload)).toEqual({ x: 'v=' });
  });

  test('returns an empty object for an absent template', () => {
    expect(renderTemplate(undefined, payload)).toEqual({});
  });
});
