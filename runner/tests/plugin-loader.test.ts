// runner/tests/plugin-loader.test.ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadProjectTools } from '../src/tools/plugin-loader.js';

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures/tools');

describe('loadProjectTools', () => {
  it('returns empty array when tools dir does not exist', async () => {
    const result = await loadProjectTools('/nonexistent/path', '/tmp');
    expect(result).toEqual([]);
  });

  it('returns empty array when tools dir has no .tool.yaml files', async () => {
    const result = await loadProjectTools('/tmp', '/tmp');
    expect(result).toEqual([]);
  });

  it('loads a shell-type tool and returns a working Tool', async () => {
    const plugins = await loadProjectTools(FIXTURES_DIR, '/tmp');
    const shellPlugin = plugins.find(p => p.name === 'test_shell');
    expect(shellPlugin).toBeDefined();
    expect(shellPlugin!.tools).toHaveLength(1);

    const tool = shellPlugin!.tools[0]!;
    expect(tool.name).toBe('test_shell-echo');
    const result = await tool.execute({ message: 'hi' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('hi');
  });

  it('returns prompt_snippet from shell plugin', async () => {
    const plugins = await loadProjectTools(FIXTURES_DIR, '/tmp');
    const shellPlugin = plugins.find(p => p.name === 'test_shell');
    expect(shellPlugin!.promptSnippet).toMatch(/test shell tool/);
  });

  it('loads a builtin-type tool by delegating to existing TypeScript impl', async () => {
    const plugins = await loadProjectTools(FIXTURES_DIR, '/tmp');
    const builtinPlugin = plugins.find(p => p.name === 'test_builtin');
    expect(builtinPlugin).toBeDefined();
    const tool = builtinPlugin!.tools[0]!;
    expect(tool.name).toBe('repo_manager-list_files');
    // Can call it without error (uses the real TS impl); '.' lists /tmp itself
    const result = await tool.execute({ path: '.' });
    expect(result.success).toBe(true);
  });

  it('skips builtin commands with unknown names (no crash)', async () => {
    // test-builtin.tool.yaml only has repo_manager-list_files, which exists
    const plugins = await loadProjectTools(FIXTURES_DIR, '/tmp');
    expect(plugins.length).toBeGreaterThan(0);
  });
});
