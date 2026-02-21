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
