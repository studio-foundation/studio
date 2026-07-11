import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../src/tools/tool-registry.js';

function makeTool(name: string) {
  return {
    name,
    description: `Tool ${name}`,
    parameters: {},
    execute: async () => ({ success: true as const, output: null }),
  };
}

describe('ToolRegistry.registerPlugin', () => {
  it('registers all tools in a plugin', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('my_plugin', [makeTool('my_plugin-foo'), makeTool('my_plugin-bar')]);
    expect(registry.has('my_plugin-foo')).toBe(true);
    expect(registry.has('my_plugin-bar')).toBe(true);
  });

  it('stores the prompt snippet for retrieval', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('my_plugin', [makeTool('my_plugin-foo')], 'Use foo carefully.');
    expect(registry.getActiveSnippets()).toEqual(['Use foo carefully.']);
  });

  it('getActiveSnippets returns empty when no snippets registered', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('my_plugin', [makeTool('my_plugin-foo')]);
    expect(registry.getActiveSnippets()).toEqual([]);
  });
});

describe('ToolRegistry.filter preserves snippet metadata', () => {
  it('filtered registry returns snippet for included tools', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('plug_a', [makeTool('plug_a-foo')], 'Snippet A');
    registry.registerPlugin('plug_b', [makeTool('plug_b-bar')], 'Snippet B');

    const filtered = registry.filter(['plug_a-foo']);
    expect(filtered.getActiveSnippets()).toEqual(['Snippet A']);
  });

  it('filtered registry does not return snippet for excluded tools', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('plug_a', [makeTool('plug_a-foo')], 'Snippet A');
    registry.registerPlugin('plug_b', [makeTool('plug_b-bar')], 'Snippet B');

    const filtered = registry.filter(['plug_a-foo']);
    expect(filtered.getActiveSnippets()).not.toContain('Snippet B');
  });

  it('normalizes dot-notation in filter with snippets', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('repo_manager', [makeTool('repo_manager-write_file')], 'Write files!');
    const filtered = registry.filter(['repo_manager.write_file']);
    expect(filtered.getActiveSnippets()).toEqual(['Write files!']);
  });
});

describe('ToolRegistry.filter — fail loud on unknown, expand plugins (STU-409)', () => {
  it('throws when a whitelisted tool is neither a known tool nor a plugin', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('repo_manager', [makeTool('repo_manager-write_file')]);
    expect(() => registry.filter(['does_not_exist'])).toThrow(
      /Unknown tool or plugin 'does_not_exist'/
    );
  });

  it('names the agent in the error when provided', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('repo_manager', [makeTool('repo_manager-write_file')]);
    expect(() => registry.filter(['bogus'], { agentName: 'analyst' })).toThrow(
      /agent 'analyst'/
    );
  });

  it('lists available tools and plugins in the error', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('repo_manager', [makeTool('repo_manager-write_file')]);
    let message = '';
    try {
      registry.filter(['bogus']);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('repo_manager');
  });

  it('expands a plugin name to all its commands', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('repo_manager', [
      makeTool('repo_manager-read_file'),
      makeTool('repo_manager-write_file'),
      makeTool('repo_manager-list_files'),
    ]);
    const filtered = registry.filter(['repo_manager']);
    expect(filtered.has('repo_manager-read_file')).toBe(true);
    expect(filtered.has('repo_manager-write_file')).toBe(true);
    expect(filtered.has('repo_manager-list_files')).toBe(true);
  });

  it('expands only the named plugin, not others', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('repo_manager', [makeTool('repo_manager-read_file')]);
    registry.registerPlugin('git', [makeTool('git-commit')]);
    const filtered = registry.filter(['repo_manager']);
    expect(filtered.has('repo_manager-read_file')).toBe(true);
    expect(filtered.has('git-commit')).toBe(false);
  });

  it('carries the plugin snippet when expanding a plugin name', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('repo_manager', [makeTool('repo_manager-read_file')], 'Read/write files.');
    const filtered = registry.filter(['repo_manager']);
    expect(filtered.getActiveSnippets()).toEqual(['Read/write files.']);
  });

  it('still accepts full tool names alongside plugin names', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('repo_manager', [
      makeTool('repo_manager-read_file'),
      makeTool('repo_manager-write_file'),
    ]);
    registry.registerPlugin('git', [makeTool('git-commit')]);
    const filtered = registry.filter(['repo_manager', 'git-commit']);
    expect(filtered.has('repo_manager-read_file')).toBe(true);
    expect(filtered.has('repo_manager-write_file')).toBe(true);
    expect(filtered.has('git-commit')).toBe(true);
  });

  it('returns an empty registry for an empty whitelist (no error)', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('repo_manager', [makeTool('repo_manager-read_file')]);
    expect(() => registry.filter([])).not.toThrow();
    expect(registry.filter([]).list()).toHaveLength(0);
  });
});

describe('clone', () => {
  it('creates an independent copy with all tools', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('my_plugin', [
      { name: 'my_plugin-cmd', description: 'test', parameters: {}, execute: async () => ({ content: 'ok' }) },
    ], 'my snippet');

    const clone = registry.clone();
    expect(clone.get('my_plugin-cmd')).toBeDefined();
    expect(clone.getActiveSnippets()).toContain('my snippet');
  });

  it('mutations to clone do not affect original', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('original', [
      { name: 'original-cmd', description: 'test', parameters: {}, execute: async () => ({ content: 'ok' }) },
    ]);
    const clone = registry.clone();
    clone.registerPlugin('extra', [
      { name: 'extra-cmd', description: 'test', parameters: {}, execute: async () => ({ content: 'ok' }) },
    ]);
    expect(registry.get('extra-cmd')).toBeUndefined();
  });
});
