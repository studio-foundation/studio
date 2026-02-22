import { describe, it, expect } from 'vitest';
import { buildPrompt } from './prompt-builder.js';
import type { AgentConfig } from '@studio/contracts';

const AGENT: AgentConfig = {
  name: 'test-agent',
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  system_prompt: 'You are a helpful assistant.',
};

const TASK = { description: 'Do the thing.' };

describe('buildPrompt — startup_context', () => {
  it('renders each startup_context key as a ### section under ## Pipeline Startup Context', () => {
    const messages = buildPrompt({
      agent: AGENT,
      task: TASK,
      context: {
        startup_context: {
          git_status: 'M src/foo.ts',
          recent_commits: 'abc123 feat: stuff',
        },
      },
    });
    const userMsg = messages.find(m => m.role === 'user')!.content as string;
    expect(userMsg).toContain('## Pipeline Startup Context');
    expect(userMsg).toContain('### git_status');
    expect(userMsg).toContain('M src/foo.ts');
    expect(userMsg).toContain('### recent_commits');
    expect(userMsg).toContain('abc123 feat: stuff');
  });

  it('omits the section when startup_context is absent', () => {
    const messages = buildPrompt({
      agent: AGENT,
      task: TASK,
      context: {},
    });
    const userMsg = messages.find(m => m.role === 'user')!.content as string;
    expect(userMsg).not.toContain('Pipeline Startup Context');
  });

  it('omits the section when startup_context is empty', () => {
    const messages = buildPrompt({
      agent: AGENT,
      task: TASK,
      context: { startup_context: {} },
    });
    const userMsg = messages.find(m => m.role === 'user')!.content as string;
    expect(userMsg).not.toContain('Pipeline Startup Context');
  });
});
