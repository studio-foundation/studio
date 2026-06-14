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
    createDefaultRegistry({ claudeCode: { model: 'claude-haiku-4-5' } });
    expect(ClaudeCodeProvider).toHaveBeenCalledWith({ model: 'claude-haiku-4-5' });
  });
});
