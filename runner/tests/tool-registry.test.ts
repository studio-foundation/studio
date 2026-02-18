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
