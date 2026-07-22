import { describe, it, expect, afterEach } from 'vitest';
import { resolveEnvVars } from './env-vars.js';

describe('resolveEnvVars', () => {
  afterEach(() => {
    delete process.env.STUDIO_TEST_VAR;
  });

  it('substitutes a set variable', () => {
    process.env.STUDIO_TEST_VAR = 'claude-code';
    expect(resolveEnvVars('provider: ${STUDIO_TEST_VAR}')).toBe('provider: claude-code');
  });

  it('substitutes an unset variable with empty string (no default)', () => {
    expect(resolveEnvVars('provider: ${STUDIO_TEST_VAR}')).toBe('provider: ');
  });

  it('falls back to the default when the variable is unset', () => {
    expect(resolveEnvVars('provider: ${STUDIO_TEST_VAR:-claude-code}')).toBe('provider: claude-code');
  });

  it('falls back to the default when the variable is set but empty', () => {
    process.env.STUDIO_TEST_VAR = '';
    expect(resolveEnvVars('model: ${STUDIO_TEST_VAR:-claude-haiku-4-5}')).toBe('model: claude-haiku-4-5');
  });

  it('prefers the set variable over the default', () => {
    process.env.STUDIO_TEST_VAR = 'opus';
    expect(resolveEnvVars('model: ${STUDIO_TEST_VAR:-claude-haiku-4-5}')).toBe('model: opus');
  });

  it('keeps a model tag colon in the default intact', () => {
    expect(resolveEnvVars('model: ${STUDIO_TEST_VAR:-mistral:7b-instruct}')).toBe('model: mistral:7b-instruct');
  });
});
