import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, resolveEnvVars } from '../src/config.js';

const TEST_DIR = resolve(import.meta.dirname, '.tmp-config-test');

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('should load a valid .studiorc.yaml', async () => {
    const configPath = resolve(TEST_DIR, '.studiorc.yaml');
    await writeFile(
      configPath,
      `providers:
  anthropic:
    apiKey: sk-test-123

paths:
  pipelines: ./my-pipelines

defaults:
  provider: anthropic
`
    );

    const config = await loadConfig(configPath);
    expect(config.providers?.anthropic?.apiKey).toBe('sk-test-123');
    expect(config.paths?.pipelines).toBe('./my-pipelines');
    expect(config.defaults?.provider).toBe('anthropic');
  });

  it('should resolve environment variables', async () => {
    vi.stubEnv('TEST_API_KEY', 'resolved-key-456');

    const configPath = resolve(TEST_DIR, '.studiorc.yaml');
    await writeFile(
      configPath,
      `providers:
  anthropic:
    apiKey: \${TEST_API_KEY}
`
    );

    const config = await loadConfig(configPath);
    expect(config.providers?.anthropic?.apiKey).toBe('resolved-key-456');

    vi.unstubAllEnvs();
  });

  it('should return empty config when file is missing (no explicit path)', async () => {
    // loadConfig with no argument searches cwd — won't find anything in TEST_DIR
    const config = await loadConfig();
    // Should not throw, should return empty-ish config
    expect(config).toBeDefined();
  });

  it('should throw on explicitly missing config path', async () => {
    await expect(
      loadConfig(resolve(TEST_DIR, 'nonexistent.yaml'))
    ).rejects.toThrow('Config file not found');
  });

  it('should throw on malformed YAML', async () => {
    const configPath = resolve(TEST_DIR, 'bad.yaml');
    await writeFile(configPath, '{{{{invalid yaml}}}}::: [[[');

    await expect(loadConfig(configPath)).rejects.toThrow('Failed to parse config');
  });
});

describe('resolveEnvVars', () => {
  it('should replace ${VAR} with env value', () => {
    vi.stubEnv('MY_KEY', 'hello');
    expect(resolveEnvVars('key: ${MY_KEY}')).toBe('key: hello');
    vi.unstubAllEnvs();
  });

  it('should replace missing env vars with empty string', () => {
    delete process.env['NONEXISTENT_VAR_XYZ'];
    expect(resolveEnvVars('key: ${NONEXISTENT_VAR_XYZ}')).toBe('key: ');
  });

  it('should handle multiple env vars', () => {
    vi.stubEnv('A', '1');
    vi.stubEnv('B', '2');
    expect(resolveEnvVars('${A}-${B}')).toBe('1-2');
    vi.unstubAllEnvs();
  });
});
