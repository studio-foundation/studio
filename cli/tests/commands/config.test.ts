import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  getConfigValue,
  setConfigValue,
  maskSecrets,
  PROVIDERS,
  validateApiKeyForProvider,
} from '../../src/commands/config.js';

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

describe('PROVIDERS', () => {
  it('includes anthropic, openai, google, local', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('google');
    expect(ids).toContain('local');
  });

  it('each provider has id, label, and defaultModel', () => {
    for (const p of PROVIDERS) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.label).toBe('string');
      expect(typeof p.defaultModel).toBe('string');
    }
  });
});

describe('validateApiKeyForProvider', () => {
  it('accepts a valid Anthropic key (sk-ant-...)', () => {
    expect(validateApiKeyForProvider('anthropic', 'sk-ant-api03-abc123')).toBe(true);
  });

  it('rejects an Anthropic key with wrong prefix', () => {
    const result = validateApiKeyForProvider('anthropic', 'sk-wrong');
    expect(typeof result).toBe('string');
    expect(result).toContain('sk-ant-');
  });

  it('accepts a valid OpenAI key (sk-...)', () => {
    expect(validateApiKeyForProvider('openai', 'sk-proj-abc123')).toBe(true);
  });

  it('rejects an OpenAI key with wrong prefix', () => {
    const result = validateApiKeyForProvider('openai', 'wrong-key');
    expect(typeof result).toBe('string');
    expect(result).toContain('sk-');
  });

  it('rejects an Anthropic-prefixed key when provider is openai', () => {
    const result = validateApiKeyForProvider('openai', 'sk-ant-api03-abc');
    expect(typeof result).toBe('string');
  });

  it('accepts a valid Google key (AIza...)', () => {
    expect(validateApiKeyForProvider('google', 'AIzaSyABC123')).toBe(true);
  });

  it('rejects a Google key with wrong prefix', () => {
    const result = validateApiKeyForProvider('google', 'wrong-key');
    expect(typeof result).toBe('string');
    expect(result).toContain('AIza');
  });

  it('accepts any value for local provider (no validation)', () => {
    expect(validateApiKeyForProvider('local', 'http://localhost:11434')).toBe(true);
    expect(validateApiKeyForProvider('local', '')).toBe(true);
  });

  it('accepts any value for unknown providers', () => {
    expect(validateApiKeyForProvider('future-provider', 'any-key')).toBe(true);
  });
});
