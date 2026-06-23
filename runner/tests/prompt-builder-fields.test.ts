import { describe, it, expect } from 'vitest';
import { buildPrompt, hasFields } from '../src/prompt-builder.js';
import type { AgentConfig, TaskInput } from '@studio-foundation/contracts';

const AGENT: AgentConfig = { name: 'a', provider: 'mock', model: 'm', system_prompt: 'sys' };

function userContent(messages: ReturnType<typeof buildPrompt>): string {
  return messages.find(m => m.role === 'user')!.content;
}

describe('hasFields', () => {
  it('is false for a flat description, true for a non-empty record, false for an empty record', () => {
    expect(hasFields({ description: 'do the thing' } as TaskInput)).toBe(false);
    expect(hasFields({ description: '', fields: { from: 'x', body: 'y' } } as TaskInput)).toBe(true);
    expect(hasFields({ description: 'fallback', fields: {} } as TaskInput)).toBe(false);
  });
});

describe('buildPrompt task rendering', () => {
  it('renders the flat description when no fields are present (unchanged)', () => {
    const messages = buildPrompt({ agent: AGENT, task: { description: 'Do the thing.' }, context: {} });
    expect(userContent(messages)).toContain('## Task\n\nDo the thing.');
  });

  it('renders each named field under ## Task when fields are present', () => {
    const messages = buildPrompt({
      agent: AGENT,
      task: { description: '', fields: { from: 'EMAIL_1', body: 'Reply to EMAIL_1' } },
      context: {},
    });
    const content = userContent(messages);
    expect(content).toContain('## Task');
    expect(content).toContain('### from\n\nEMAIL_1');
    expect(content).toContain('### body\n\nReply to EMAIL_1');
  });

  it('does NOT render the raw description when fields are present (no PII leak path)', () => {
    const messages = buildPrompt({
      agent: AGENT,
      task: { description: 'RAW_SECRET mc@acme.com', fields: { body: 'EMAIL_1' } },
      context: {},
    });
    const content = userContent(messages);
    expect(content).not.toContain('RAW_SECRET');
    expect(content).not.toContain('mc@acme.com');
    expect(content).toContain('### body\n\nEMAIL_1');
  });

  it('falls back to description when fields is an empty object', () => {
    const messages = buildPrompt({
      agent: AGENT,
      task: { description: 'Fallback text.', fields: {} },
      context: {},
    });
    expect(userContent(messages)).toContain('## Task\n\nFallback text.');
  });
});
