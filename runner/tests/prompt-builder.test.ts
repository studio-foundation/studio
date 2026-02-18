/**
 * Prompt builder tests
 */

import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../src/prompt-builder.js';
import type { AgentConfig } from '@studio/contracts';

describe('PromptBuilder', () => {
  it('should build basic prompt', () => {
    const agent: AgentConfig = {
      name: 'test-agent',
      provider: 'openai',
      model: 'gpt-4',
      system_prompt: 'You are a helpful assistant.'
    };

    const messages = buildPrompt({
      agent,
      task: {
        description: 'Write a hello world function'
      },
      context: {}
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: 'system',
      content: 'You are a helpful assistant.'
    });
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('Write a hello world function');
  });

  it('should include previous outputs in context', () => {
    const agent: AgentConfig = {
      name: 'test-agent',
      provider: 'openai',
      model: 'gpt-4'
    };

    const messages = buildPrompt({
      agent,
      task: {
        description: 'Generate code'
      },
      context: {
        previous_outputs: {
          analysis: { findings: 'Good code structure' }
        }
      }
    });

    expect(messages[1].content).toContain('Previous Stage Outputs');
    expect(messages[1].content).toContain('analysis');
    expect(messages[1].content).toContain('Good code structure');
  });

  it('should add retry escalation for attempt 2', () => {
    const agent: AgentConfig = {
      name: 'test-agent',
      provider: 'openai',
      model: 'gpt-4'
    };

    const messages = buildPrompt({
      agent,
      task: {
        description: 'Fix the bug'
      },
      context: {},
      executionContext: {
        attempt: 2,
        previous_failures: [
          { error: 'No tool calls made', tool_calls_count: 0 }
        ]
      }
    });

    expect(messages[1].content).toContain('RETRY ATTEMPT 2');
    expect(messages[1].content).toContain('No tool calls made');
    expect(messages[1].content).toContain('Problem: No tool calls were made');
  });

  it('should add stronger retry escalation for attempt 3+', () => {
    const agent: AgentConfig = {
      name: 'test-agent',
      provider: 'openai',
      model: 'gpt-4'
    };

    const messages = buildPrompt({
      agent,
      task: {
        description: 'Fix the bug'
      },
      context: {},
      executionContext: {
        attempt: 3,
        previous_failures: [
          { error: 'No tool calls', tool_calls_count: 0 },
          { error: 'Still no tool calls', tool_calls_count: 0 }
        ]
      }
    });

    expect(messages[1].content).toContain('CRITICAL: RETRY ATTEMPT 3');
    expect(messages[1].content).toContain('YOU MUST:');
  });

  it('should add tool call requirements for code_generation stage', () => {
    const agent: AgentConfig = {
      name: 'test-agent',
      provider: 'openai',
      model: 'gpt-4'
    };

    const messages = buildPrompt({
      agent,
      task: {
        description: 'Generate code',
        stage_kind: 'code_generation'
      },
      context: {}
    });

    expect(messages[0].content).toContain('CRITICAL: Code Generation Workflow');
    expect(messages[0].content).toContain('repo_manager');
  });
});

describe('buildPrompt - context_packs', () => {
  it('renders each pack as its own ## section with description', () => {
    const messages = buildPrompt({
      agent: { name: 'test', system_prompt: 'You are helpful.', provider: 'mock', model: 'mock' } as any,
      task: { description: 'Do the task.' },
      context: {
        context_packs: [
          {
            name: 'React Conventions',
            description: 'React coding standards',
            sections: [
              { title: 'Naming conventions', content: '- Components: PascalCase' },
            ],
          },
        ],
      },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    expect(userContent).toContain('## React Conventions — React coding standards');
    expect(userContent).toContain('### Naming conventions');
    expect(userContent).toContain('- Components: PascalCase');
    // Pack appears before ## Task
    expect(userContent.indexOf('## React Conventions')).toBeLessThan(userContent.indexOf('## Task'));
  });

  it('renders pack without description (no dash suffix)', () => {
    const messages = buildPrompt({
      agent: { name: 'test', system_prompt: 'You are helpful.', provider: 'mock', model: 'mock' } as any,
      task: { description: 'Do the task.' },
      context: {
        context_packs: [
          {
            name: 'Testing Standards',
            sections: [{ title: 'Coverage', content: 'Aim for 80%.' }],
          },
        ],
      },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    expect(userContent).toContain('## Testing Standards\n\n');
    expect(userContent).not.toContain('## Testing Standards —');
  });

  it('renders multiple packs in order', () => {
    const messages = buildPrompt({
      agent: { name: 'test', system_prompt: 'You are helpful.', provider: 'mock', model: 'mock' } as any,
      task: { description: 'Do the task.' },
      context: {
        context_packs: [
          { name: 'Pack A', sections: [{ title: 'A', content: 'a' }] },
          { name: 'Pack B', sections: [{ title: 'B', content: 'b' }] },
        ],
      },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    expect(userContent.indexOf('## Pack A')).toBeLessThan(userContent.indexOf('## Pack B'));
  });

  it('skips pack rendering when context_packs is empty or absent', () => {
    const messages = buildPrompt({
      agent: { name: 'test', system_prompt: 'You are helpful.', provider: 'mock', model: 'mock' } as any,
      task: { description: 'Do the task.' },
      context: { context_packs: [] },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    // Only ## Task should be present (no pack ## headers)
    const headers = [...userContent.matchAll(/^## /gm)];
    expect(headers).toHaveLength(1);
  });
});
