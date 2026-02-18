import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getConfigValue, setConfigValue, maskSecrets } from '../../src/commands/config.js';

const TMP = resolve(import.meta.dirname, '.tmp-config-cmd-test');
const STUDIO_DIR = resolve(TMP, '.studio');

beforeEach(async () => { await mkdir(STUDIO_DIR, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

describe('getConfigValue', () => {
  it('gets a nested value by dotted path', () => {
    const config = { defaults: { model: 'claude-haiku' } };
    expect(getConfigValue(config, 'defaults.model')).toBe('claude-haiku');
  });

  it('returns undefined for missing path', () => {
    expect(getConfigValue({}, 'defaults.model')).toBeUndefined();
  });
});

describe('setConfigValue', () => {
  it('sets a nested value by dotted path', () => {
    const config: Record<string, unknown> = {};
    setConfigValue(config, 'defaults.model', 'claude-sonnet');
    expect((config as any).defaults.model).toBe('claude-sonnet');
  });

  it('merges without destroying sibling keys', () => {
    const config = { defaults: { provider: 'anthropic', model: 'old' } };
    setConfigValue(config, 'defaults.model', 'new');
    expect((config as any).defaults.provider).toBe('anthropic');
    expect((config as any).defaults.model).toBe('new');
  });
});

describe('maskSecrets', () => {
  it('masks apiKey values', () => {
    const config = { providers: { anthropic: { apiKey: 'sk-ant-longkey' } } };
    const masked = maskSecrets(config);
    expect((masked as any).providers.anthropic.apiKey).toMatch(/\*\*\*/);
    expect((masked as any).providers.anthropic.apiKey).not.toContain('longkey');
  });

  it('preserves non-secret values', () => {
    const config = { defaults: { model: 'claude-haiku' } };
    expect((maskSecrets(config) as any).defaults.model).toBe('claude-haiku');
  });
});
