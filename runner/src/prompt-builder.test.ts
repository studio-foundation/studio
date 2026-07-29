import { describe, it, expect } from 'vitest';
import { buildPrompt } from './prompt-builder.js';
import type { AgentConfig } from '@studio-foundation/contracts';
import type { SkillContent } from './tools/skills/skill-loader.js';

const AGENT: AgentConfig = {
  name: 'test-agent',
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  system_prompt: 'You are a helpful assistant.',
};

const TASK = { description: 'Do the thing.' };

describe('buildPrompt — previous_tool_results', () => {
  it('renders write_file content from tc.arguments.content', () => {
    const messages = buildPrompt({
      agent: AGENT,
      task: TASK,
      context: {
        previous_tool_results: {
          'code-generation': [
            {
              id: '1',
              name: 'repo_manager-write_file',
              arguments: { path: 'src/foo.ts', content: 'const x = 1;' },
              result: { written: true },
            },
          ],
        },
      },
    });
    const userMsg = messages.find(m => m.role === 'user')!.content as string;
    expect(userMsg).toContain('Previous Stage Discoveries (code-generation)');
    expect(userMsg).toContain('const x = 1;');
    // Should NOT show the useless {written: true} result as the body
    expect(userMsg).not.toContain('"written": true');
  });

  it('renders read_file content from tc.result', () => {
    const messages = buildPrompt({
      agent: AGENT,
      task: TASK,
      context: {
        previous_tool_results: {
          'brief-analysis': [
            {
              id: '1',
              name: 'repo_manager-read_file',
              arguments: { path: 'src/foo.ts' },
              result: { path: 'src/foo.ts', content: 'const y = 2;' },
            },
          ],
        },
      },
    });
    const userMsg = messages.find(m => m.role === 'user')!.content as string;
    expect(userMsg).toContain('Previous Stage Discoveries (brief-analysis)');
    expect(userMsg).toContain('const y = 2;');
  });

  it('omits the section when previous_tool_results is absent', () => {
    const messages = buildPrompt({ agent: AGENT, task: TASK, context: {} });
    const userMsg = messages.find(m => m.role === 'user')!.content as string;
    expect(userMsg).not.toContain('Previous Stage Discoveries');
  });
});

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

describe('buildPrompt — skills injection', () => {
  it('injects a single skill into the system prompt', () => {
    const skills: SkillContent[] = [
      { name: 'commit-conventions', content: '# Commit Conventions\n\nUse conventional commits.' },
    ];
    const messages = buildPrompt({ agent: AGENT, task: TASK, context: {}, skills });
    const sysMsg = messages.find(m => m.role === 'system')!.content as string;
    expect(sysMsg).toContain('## Skill: commit-conventions');
    expect(sysMsg).toContain('Use conventional commits.');
  });

  it('injects multiple skills separated by ---', () => {
    const skills: SkillContent[] = [
      { name: 'commit-conventions', content: 'Commit content.' },
      { name: 'react-patterns', content: 'React content.' },
    ];
    const messages = buildPrompt({ agent: AGENT, task: TASK, context: {}, skills });
    const sysMsg = messages.find(m => m.role === 'system')!.content as string;
    expect(sysMsg).toContain('## Skill: commit-conventions');
    expect(sysMsg).toContain('## Skill: react-patterns');
    expect(sysMsg).toContain('---');
  });

  it('omits skill section when skills array is empty', () => {
    const messages = buildPrompt({ agent: AGENT, task: TASK, context: {}, skills: [] });
    const sysMsg = messages.find(m => m.role === 'system')!.content as string;
    expect(sysMsg).not.toContain('## Skill:');
  });

  it('omits skill section when skills is not provided', () => {
    const messages = buildPrompt({ agent: AGENT, task: TASK, context: {} });
    const sysMsg = messages.find(m => m.role === 'system')!.content as string;
    expect(sysMsg).not.toContain('## Skill:');
  });
});

describe('buildPrompt — stage_name', () => {
  it('renders ## Stage Name section when stage_name is provided', () => {
    const messages = buildPrompt({
      agent: AGENT,
      task: TASK,
      context: { stage_name: 'recipe-1' },
    });
    const userMsg = messages.find(m => m.role === 'user')!.content as string;
    expect(userMsg).toContain('## Stage Name');
    expect(userMsg).toContain('recipe-1');
  });

  it('does not render ## Stage Name when stage_name is absent', () => {
    const messages = buildPrompt({
      agent: AGENT,
      task: TASK,
      context: {},
    });
    const userMsg = messages.find(m => m.role === 'user')!.content as string;
    expect(userMsg).not.toContain('## Stage Name');
  });
});

describe('buildPrompt — plugin skills and project invariants', () => {
  it('injects plugin skill chunks separated by ---', () => {
    const messages = buildPrompt({
      agent: AGENT,
      task: TASK,
      context: {},
      pluginSkills: ['# Plugin A', '# Plugin B'],
    });
    const sysMsg = messages.find(m => m.role === 'system')!.content as string;
    expect(sysMsg).toContain('# Plugin A\n\n---\n\n# Plugin B');
  });

  it('injects project invariants under a Project Invariants heading', () => {
    const messages = buildPrompt({
      agent: AGENT,
      task: TASK,
      context: {},
      projectInvariants: 'Never delete the audit log.',
    });
    const sysMsg = messages.find(m => m.role === 'system')!.content as string;
    expect(sysMsg).toContain('## Project Invariants\n\nNever delete the audit log.');
  });

  it('orders the identity block ahead of the output format section', () => {
    const skills: SkillContent[] = [{ name: 'commit-conventions', content: 'Use conventional commits.' }];
    const messages = buildPrompt({
      agent: AGENT,
      task: TASK,
      context: {},
      pluginSkills: ['# Plugin A'],
      skills,
      projectInvariants: 'Never delete the audit log.',
      outputContract: { name: 'c', version: 1, schema: { required_fields: ['summary'] } },
    });
    const sysMsg = messages.find(m => m.role === 'system')!.content as string;
    expect(sysMsg.indexOf('# Plugin A')).toBeLessThan(sysMsg.indexOf('## Skill: commit-conventions'));
    expect(sysMsg.indexOf('## Skill: commit-conventions')).toBeLessThan(sysMsg.indexOf('## Project Invariants'));
    expect(sysMsg.indexOf('## Project Invariants')).toBeLessThan(sysMsg.indexOf('## REQUIRED OUTPUT FORMAT'));
  });

  it('omits every section when nothing is provided', () => {
    const messages = buildPrompt({ agent: AGENT, task: TASK, context: {} });
    const sysMsg = messages.find(m => m.role === 'system')!.content as string;
    expect(sysMsg).toBe('You are a helpful assistant.');
  });
});
