import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  checkConfig,
  formatConfigCheckError,
  leafKeyPaths,
} from '../src/config-validation.js';

const STUDIO_DIR = resolve('/tmp', '.studio-config-validation-test');

beforeEach(async () => {
  await mkdir(STUDIO_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(STUDIO_DIR, { recursive: true, force: true });
});

const write = (name: string, content: string) =>
  writeFile(join(STUDIO_DIR, name), content, 'utf-8');

describe('leafKeyPaths', () => {
  it('returns dotted paths for nested scalars', () => {
    expect(leafKeyPaths({ defaults: { provider: 'ollama', model: 'llama3.3' } })).toEqual([
      'defaults.provider',
      'defaults.model',
    ]);
  });

  it('treats an empty object as a leaf', () => {
    expect(leafKeyPaths({ providers: { ollama: {} } })).toEqual(['providers.ollama']);
  });

  it('treats an array as a leaf', () => {
    expect(leafKeyPaths({ paths: { pipelines: ['a', 'b'] } })).toEqual(['paths.pipelines']);
  });
});

describe('checkConfig', () => {
  it('reports no-contract when config.example.yaml is absent', async () => {
    await write('config.yaml', 'defaults:\n  provider: ollama\n');
    const result = await checkConfig(STUDIO_DIR);
    expect(result.status).toBe('no-contract');
    expect(formatConfigCheckError(result)).toBeNull();
  });

  it('reports missing-config when the example exists but config.yaml does not', async () => {
    await write('config.example.yaml', 'defaults:\n  provider: ollama\n');
    const result = await checkConfig(STUDIO_DIR);
    expect(result.status).toBe('missing-config');
    expect(formatConfigCheckError(result)).toContain('cp ');
  });

  it('passes when every uncommented example key is present', async () => {
    await write(
      'config.example.yaml',
      '# providers:\n#   anthropic:\n#     apiKey: ${ANTHROPIC_API_KEY}\ndefaults:\n  provider: ollama\n  model: llama3.3\n'
    );
    await write(
      'config.yaml',
      'providers:\n  anthropic:\n    apiKey: sk-ant-test\ndefaults:\n  provider: anthropic\n  model: claude-sonnet-4-20250514\n'
    );
    const result = await checkConfig(STUDIO_DIR);
    expect(result.status).toBe('ok');
    expect(result.missingKeys).toEqual([]);
  });

  it('lists every missing key path', async () => {
    await write(
      'config.example.yaml',
      'providers:\n  anthropic:\n    apiKey: ${ANTHROPIC_API_KEY}\ndefaults:\n  provider: anthropic\n  model: claude-sonnet-4-20250514\n'
    );
    await write('config.yaml', 'defaults:\n  provider: anthropic\n');
    const result = await checkConfig(STUDIO_DIR);
    expect(result.status).toBe('missing-keys');
    expect(result.missingKeys).toEqual(['providers.anthropic.apiKey', 'defaults.model']);

    const error = formatConfigCheckError(result);
    expect(error).toContain('providers.anthropic.apiKey');
    expect(error).toContain('config.example.yaml');
  });

  it('accepts an empty value for a declared key — presence is the contract', async () => {
    await write('config.example.yaml', 'providers:\n  ollama: {}\n');
    await write('config.yaml', 'providers:\n  ollama: {}\n');
    expect((await checkConfig(STUDIO_DIR)).status).toBe('ok');
  });
});
