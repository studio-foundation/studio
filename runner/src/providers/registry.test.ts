import { describe, it, expect, vi } from 'vitest';
import { createDefaultRegistry } from './registry.js';

vi.mock('./claude-code.js', () => ({
  ClaudeCodeProvider: vi.fn(function (this: { name: string }) { this.name = 'claude-code'; }),
}));

describe('createDefaultRegistry — claudeCode', () => {
  it('does not register claude-code when claudeCode config is absent', () => {
    const registry = createDefaultRegistry({});
    expect(registry.has('claude-code')).toBe(false);
  });

  it('registers claude-code when claudeCode config is present', () => {
    const registry = createDefaultRegistry({ claudeCode: {} });
    expect(registry.has('claude-code')).toBe(true);
  });

  it('passes model from claudeCode config to ClaudeCodeProvider', async () => {
    const { ClaudeCodeProvider } = await import('./claude-code.js');
    createDefaultRegistry({ claudeCode: { model: 'claude-haiku-4-5' } }).get('claude-code');
    expect(ClaudeCodeProvider).toHaveBeenCalledWith({ model: 'claude-haiku-4-5' });
  });
});

describe('createDefaultRegistry — lazy construction', () => {
  it('does not construct a declared provider until it is requested', () => {
    const registry = createDefaultRegistry({ openai: { apiKey: '' } });
    expect(registry.has('openai')).toBe(true);
    expect(registry.list()).toContain('openai');
  });

  it('reports the missing key when an empty-key provider is requested', () => {
    const registry = createDefaultRegistry({ openai: { apiKey: '  ' } });
    expect(() => registry.get('openai')).toThrow(
      /Provider "openai" failed to initialize: no API key\. Set providers\.openai\.apiKey/
    );
  });

  it('lets an unused empty-key block coexist with a usable provider', () => {
    const registry = createDefaultRegistry({
      openai: { apiKey: '' },
      anthropic: { apiKey: 'sk-real' },
    });
    expect(registry.get('anthropic').name).toBe('anthropic');
  });

  it('builds a lazy provider once and caches it', () => {
    const registry = createDefaultRegistry({ anthropic: { apiKey: 'sk-real' } });
    expect(registry.get('anthropic')).toBe(registry.get('anthropic'));
  });
});
