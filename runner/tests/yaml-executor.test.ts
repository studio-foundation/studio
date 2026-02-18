// runner/tests/yaml-executor.test.ts
import { describe, it, expect } from 'vitest';
import { renderTemplate, executeShellCommand } from '../src/tools/yaml-executor.js';

describe('renderTemplate', () => {
  it('substitutes plain {{param}}', () => {
    expect(renderTemplate('echo {{message}}', { message: 'hello' })).toBe('echo hello');
  });

  it('renders {{#if param}}...{{/if}} when truthy', () => {
    expect(renderTemplate('git diff {{#if staged}}--cached{{/if}}', { staged: true }))
      .toBe('git diff --cached');
  });

  it('removes {{#if param}}...{{/if}} block when falsy', () => {
    expect(renderTemplate('git diff {{#if staged}}--cached{{/if}}', { staged: false }))
      .toBe('git diff ');
  });

  it('renders {{#if param}}...{{/if}} when param is absent', () => {
    expect(renderTemplate('git diff {{#if staged}}--cached{{/if}}', {}))
      .toBe('git diff ');
  });

  it('joins array with {{param | join sep}}', () => {
    expect(renderTemplate('git add {{files | join " "}}', { files: ['a.ts', 'b.ts'] }))
      .toBe('git add a.ts b.ts');
  });

  it('renders {{param | json}} as JSON string', () => {
    expect(renderTemplate('echo {{data | json}}', { data: ['a', 'b'] }))
      .toBe('echo ["a","b"]');
  });

  it('returns empty string for missing plain param', () => {
    expect(renderTemplate('{{missing}}', {})).toBe('');
  });

  it('handles multi-line templates', () => {
    const template = `{{#if create}}
git checkout -b {{branch}}
{{else}}
git checkout {{branch}}
{{/if}}`;
    // Note: we don't support {{else}} yet — it stays as literal text
    // Just ensure it doesn't crash and substitutes {{branch}}
    const result = renderTemplate(template, { create: false, branch: 'main' });
    expect(result).toContain('main');
  });
});

describe('executeShellCommand', () => {
  it('executes a command and returns stdout as text', async () => {
    const result = await executeShellCommand('echo hello', 'text', '/tmp');
    expect(result.success).toBe(true);
    expect(result.output).toBe('hello');
  });

  it('parses JSON output when parse_output is json', async () => {
    const result = await executeShellCommand('echo \'{"x":1}\'', 'json', '/tmp');
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ x: 1 });
  });

  it('returns error on non-zero exit code', async () => {
    const result = await executeShellCommand('exit 1', 'text', '/tmp');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error when JSON parsing fails', async () => {
    const result = await executeShellCommand('echo not-json', 'json', '/tmp');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Failed to parse JSON/);
  });
});
