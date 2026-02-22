import { describe, it, expect } from 'vitest';
import { parseAgentYaml } from './agent-loader.js';

describe('parseAgentYaml', () => {
  it('parses plugins field from agent YAML', () => {
    const yaml = `
name: code-reviewer
provider: anthropic
model: claude-sonnet-4-20250514
plugins:
  - code-review
  - analysis
tools:
  - repo_manager-read_file
`;
    const result = parseAgentYaml(yaml);
    expect(result.plugins).toEqual(['code-review', 'analysis']);
  });

  it('returns undefined plugins when not specified', () => {
    const yaml = `
name: analyst
provider: anthropic
model: claude-haiku-4-5-20251001
`;
    const result = parseAgentYaml(yaml);
    expect(result.plugins).toBeUndefined();
  });
});

describe('skill injection logic', () => {
  it('appends skill content to system_prompt when plugins match', () => {
    // Test the injection logic directly
    const agent = parseAgentYaml(`
name: test-agent
provider: anthropic
model: claude-haiku-4-5-20251001
system_prompt: "You are a reviewer."
plugins:
  - code-review
`);

    // Simulate what engine does
    const pluginSkills: Record<string, string[]> = {
      'code-review': ['## Skill: review-guidelines\n\nAlways check for bugs.'],
    };

    if (agent.plugins?.length && pluginSkills) {
      const skillChunks = agent.plugins.flatMap((p) => pluginSkills[p] ?? []);
      if (skillChunks.length > 0) {
        agent.system_prompt = `${agent.system_prompt ?? ''}\n\n${skillChunks.join('\n\n---\n\n')}`;
      }
    }

    expect(agent.system_prompt).toContain('You are a reviewer.');
    expect(agent.system_prompt).toContain('## Skill: review-guidelines');
    expect(agent.system_prompt).toContain('Always check for bugs.');
  });

  it('does not modify system_prompt when no matching plugin skills', () => {
    const agent = parseAgentYaml(`
name: test-agent
provider: anthropic
model: claude-haiku-4-5-20251001
system_prompt: "Original prompt."
plugins:
  - unknown-plugin
`);

    const pluginSkills: Record<string, string[]> = {
      'code-review': ['## Skill: review-guidelines\n\nAlways check for bugs.'],
    };

    const originalPrompt = agent.system_prompt;
    if (agent.plugins?.length && pluginSkills) {
      const skillChunks = agent.plugins.flatMap((p) => pluginSkills[p] ?? []);
      if (skillChunks.length > 0) {
        agent.system_prompt = `${agent.system_prompt ?? ''}\n\n${skillChunks.join('\n\n---\n\n')}`;
      }
    }

    expect(agent.system_prompt).toBe(originalPrompt);
  });
});

describe('skills field parsing', () => {
  it('parses skills field from agent YAML', () => {
    const yaml = `
name: coder
provider: anthropic
model: claude-sonnet-4-6
skills:
  - git-workflow
  - code-conventions
`;
    const result = parseAgentYaml(yaml);
    expect(result.skills).toEqual(['git-workflow', 'code-conventions']);
  });

  it('returns undefined skills when not specified', () => {
    const yaml = `
name: analyst
provider: anthropic
model: claude-haiku-4-5-20251001
`;
    const result = parseAgentYaml(yaml);
    expect(result.skills).toBeUndefined();
  });
});

describe('project skill injection logic', () => {
  it('appends skill content to system_prompt for declared skills', () => {
    const agent = parseAgentYaml(`
name: coder
provider: anthropic
model: claude-sonnet-4-6
system_prompt: "You are a developer."
skills:
  - git-workflow
`);

    // Simulate what engine does: format loaded skills and append to system_prompt
    const loadedSkills = [{ name: 'git-workflow', content: '# Git Workflow\n\nAlways branch from main.' }];
    if (agent.skills?.length && loadedSkills.length > 0) {
      const skillChunks = loadedSkills.map((s) => `## Skill: ${s.name}\n\n${s.content}`);
      agent.system_prompt = `${agent.system_prompt ?? ''}\n\n${skillChunks.join('\n\n---\n\n')}`;
    }

    expect(agent.system_prompt).toContain('You are a developer.');
    expect(agent.system_prompt).toContain('## Skill: git-workflow');
    expect(agent.system_prompt).toContain('Always branch from main.');
  });

  it('does not modify system_prompt when no skills declared', () => {
    const agent = parseAgentYaml(`
name: analyst
provider: anthropic
model: claude-sonnet-4-6
system_prompt: "You are an analyst."
`);

    const originalPrompt = agent.system_prompt;
    const loadedSkills: Array<{ name: string; content: string }> = [];
    if (agent.skills?.length && loadedSkills.length > 0) {
      const skillChunks = loadedSkills.map((s) => `## Skill: ${s.name}\n\n${s.content}`);
      agent.system_prompt = `${agent.system_prompt ?? ''}\n\n${skillChunks.join('\n\n---\n\n')}`;
    }

    expect(agent.system_prompt).toBe(originalPrompt);
  });
});
