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

  it('does not inject domain-specific workflow instructions regardless of task description', () => {
    const messages = buildPrompt({
      agent: { name: 'coder', provider: 'mock', model: 'mock' },
      task: { description: 'Generate code' },
      context: {}
    });
    expect(messages[0].content).not.toContain('CRITICAL: Code Generation Workflow');
    expect(messages[0].content).not.toContain('repo_manager-read_file');
  });

  it('uses "end with" phrasing when contract requires tool calls', () => {
    const messages = buildPrompt({
      agent: { name: 'coder', provider: 'mock', model: 'mock' },
      task: { description: 'Generate code' },
      context: {},
      outputContract: {
        name: 'code-generation',
        version: 1,
        schema: { required_fields: ['summary', 'files_changed'] },
        tool_calls: { minimum: 1 },
      },
    });
    const system = messages[0].content as string;
    expect(system).toContain('end with');
    expect(system).toContain('Your final message (after all tool calls)');
    expect(system).not.toContain('respond with');
  });

  it('uses "respond with" phrasing when contract has no tool call requirement', () => {
    const messages = buildPrompt({
      agent: { name: 'analyst', provider: 'mock', model: 'mock' },
      task: { description: 'Analyse the brief' },
      context: {},
      outputContract: {
        name: 'brief-analysis',
        version: 1,
        schema: { required_fields: ['summary', 'requirements'] },
      },
    });
    const system = messages[0].content as string;
    expect(system).toContain('respond with');
    expect(system).toContain('Your entire response');
    expect(system).not.toContain('end with');
  });

  it('retry messages do not reference specific tool names', () => {
    const messages2 = buildPrompt({
      agent: { name: 'coder', provider: 'mock', model: 'mock' },
      task: { description: 'Generate code' },
      context: {},
      executionContext: {
        attempt: 2,
        previous_failures: [{ error: 'Required tool not called', tool_calls_count: 0 }]
      }
    });
    expect(messages2[1].content).not.toContain('repo_manager-write_file');

    const messages3 = buildPrompt({
      agent: { name: 'coder', provider: 'mock', model: 'mock' },
      task: { description: 'Generate code' },
      context: {},
      executionContext: {
        attempt: 3,
        previous_failures: [
          { error: 'No tool calls', tool_calls_count: 0 },
          { error: 'No tool calls', tool_calls_count: 0 }
        ]
      }
    });
    expect(messages3[1].content).not.toContain('repo_manager-write_file');

    const messages4 = buildPrompt({
      agent: { name: 'coder', provider: 'mock', model: 'mock' },
      task: { description: 'Generate code' },
      context: {},
      executionContext: {
        attempt: 4,
        previous_failures: [
          { error: 'No tool calls', tool_calls_count: 0 },
          { error: 'No tool calls', tool_calls_count: 0 },
          { error: 'No tool calls', tool_calls_count: 0 }
        ]
      }
    });
    expect(messages4[1].content).not.toContain('repo_manager-write_file');
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

describe('buildPrompt with promptSnippets', () => {
  it('injects prompt snippets into system message', () => {
    const messages = buildPrompt({
      agent: { name: 'a', provider: 'anthropic', model: 'claude-haiku-4-5', tools: [] },
      task: { description: 'Do something' },
      context: {},
      promptSnippets: ['Use tool X carefully.', 'Always verify results.'],
    });
    const system = messages.find(m => m.role === 'system')!;
    expect(system.content).toContain('Use tool X carefully.');
    expect(system.content).toContain('Always verify results.');
  });

  it('does not crash when promptSnippets is empty', () => {
    expect(() =>
      buildPrompt({
        agent: { name: 'a', provider: 'anthropic', model: 'claude-haiku-4-5', tools: [] },
        task: { description: 'Do something' },
        context: {},
        promptSnippets: [],
      })
    ).not.toThrow();
  });

  it('does not crash when promptSnippets is undefined', () => {
    expect(() =>
      buildPrompt({
        agent: { name: 'a', provider: 'anthropic', model: 'claude-haiku-4-5', tools: [] },
        task: { description: 'Do something' },
        context: {},
      })
    ).not.toThrow();
  });
});

describe('buildPrompt — previous_tool_results', () => {
  const baseAgent: AgentConfig = {
    name: 'test',
    provider: 'mock',
    model: 'mock',
    system_prompt: 'You are helpful.',
  };

  it('renders a "Previous Stage Discoveries" section per stage', () => {
    const messages = buildPrompt({
      agent: baseAgent,
      task: { description: 'Do the task.' },
      context: {
        previous_tool_results: {
          'brief-analysis': [
            {
              id: '1',
              name: 'search-search_codebase',
              arguments: { pattern: 'about' },
              result: { matches: [{ file: 'src/pages/about.tsx', content: 'export default function About' }] },
            },
          ],
        },
      },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    expect(userContent).toContain('## Previous Stage Discoveries (brief-analysis)');
    expect(userContent).toContain('search-search_codebase');
    expect(userContent).toContain('about');
    expect(userContent).toContain('about.tsx');
  });

  it('discoveries section appears before the Task section', () => {
    const messages = buildPrompt({
      agent: baseAgent,
      task: { description: 'Do the task.' },
      context: {
        previous_tool_results: {
          'stage-1': [{ id: '1', name: 'tool-x', arguments: { q: 'foo' }, result: 'bar' }],
        },
      },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    const discoveriesIdx = userContent.indexOf('## Previous Stage Discoveries');
    const taskIdx = userContent.indexOf('## Task');
    expect(discoveriesIdx).toBeGreaterThan(-1);
    expect(discoveriesIdx).toBeLessThan(taskIdx);
  });

  it('truncates results longer than 2000 chars', () => {
    const longResult = 'x'.repeat(3000);
    const messages = buildPrompt({
      agent: baseAgent,
      task: { description: 'Do the task.' },
      context: {
        previous_tool_results: {
          'stage-1': [{ id: '1', name: 'tool-x', arguments: {}, result: longResult }],
        },
      },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    expect(userContent).toContain('[truncated]');
    // Should not contain the full 3000-char result
    expect(userContent).not.toContain(longResult);
  });

  it('renders tool error when present', () => {
    const messages = buildPrompt({
      agent: baseAgent,
      task: { description: 'Do the task.' },
      context: {
        previous_tool_results: {
          'stage-1': [{ id: '1', name: 'tool-x', arguments: {}, error: 'File not found' }],
        },
      },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    expect(userContent).toContain('Error: File not found');
  });

  it('skips rendering when previous_tool_results is empty or absent', () => {
    const messages = buildPrompt({
      agent: baseAgent,
      task: { description: 'Do the task.' },
      context: {},
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    expect(userContent).not.toContain('Previous Stage Discoveries');
  });
});

describe('buildPrompt — group_feedback', () => {
  const baseAgent: AgentConfig = {
    name: 'test',
    provider: 'mock',
    model: 'mock',
    system_prompt: 'You are helpful.',
  };

  it('renders group feedback as the first section in user message', () => {
    const messages = buildPrompt({
      agent: baseAgent,
      task: { description: 'Generate code.' },
      context: {
        additional_context: 'Build a dark mode toggle',
        group_feedback: {
          iteration: 1,
          max_iterations: 3,
          rejection_reason: 'Missing localStorage persistence',
          rejection_details: ['No localStorage.setItem call', 'Theme not restored on load'],
        },
      },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    expect(userContent).toContain('REVISION REQUIRED');
    expect(userContent).toContain('Iteration 2/3');
    expect(userContent).toContain('Missing localStorage persistence');
    expect(userContent).toContain('No localStorage.setItem call');
    expect(userContent).toContain('Theme not restored on load');
    // Feedback appears BEFORE additional context and task
    expect(userContent.indexOf('REVISION REQUIRED')).toBeLessThan(userContent.indexOf('Additional Context'));
    expect(userContent.indexOf('REVISION REQUIRED')).toBeLessThan(userContent.indexOf('## Task'));
  });

  it('renders feedback without details when rejection_details is empty', () => {
    const messages = buildPrompt({
      agent: baseAgent,
      task: { description: 'Generate code.' },
      context: {
        group_feedback: {
          iteration: 0,
          max_iterations: 3,
          rejection_reason: 'Code quality too low',
        },
      },
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    expect(userContent).toContain('REVISION REQUIRED');
    expect(userContent).toContain('Code quality too low');
    expect(userContent).not.toContain('Issues to fix');
  });

  it('skips feedback section when group_feedback is absent', () => {
    const messages = buildPrompt({
      agent: baseAgent,
      task: { description: 'Generate code.' },
      context: {},
    });

    const userContent = messages.find(m => m.role === 'user')!.content as string;
    expect(userContent).not.toContain('REVISION REQUIRED');
  });
});
