import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as yaml from 'js-yaml';

// Use /tmp as base to avoid interference from the Studio repo's own .studio/
const TMP = resolve('/tmp', '.studio-init-test');

beforeEach(async () => { await mkdir(TMP, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe('createStudioStructure', () => {
  it('creates .studio/ directory structure', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    expect(await exists(resolve(TMP, '.studio'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'config.yaml'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'pipelines'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'agents'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'contracts'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'tools'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'default', 'inputs'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'runs', 'logs'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'registry.lock.json'))).toBe(true);
  });

  it('adds .studio/config.yaml and .studio/runs/ to .gitignore', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    const gitignore = await readFile(resolve(TMP, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.studio/config.yaml');
    expect(gitignore).toContain('.studio/runs/');
  });

  it('appends to existing .gitignore without duplicating', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    const gitignorePath = resolve(TMP, '.gitignore');
    await writeFile(gitignorePath, 'node_modules/\n.studio/config.yaml\n');

    await createStudioStructure(TMP);

    const content = await readFile(gitignorePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim() === '.studio/config.yaml');
    expect(lines.length).toBe(1); // no duplicate
  });

  it('creates named project structure when projectName provided', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP, 'software');

    expect(await exists(resolve(TMP, '.studio', 'projects', 'software', 'pipelines'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'software', 'agents'))).toBe(true);
  });

  it('writes empty registry.lock.json', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    const content = await readFile(resolve(TMP, '.studio', 'registry.lock.json'), 'utf-8');
    expect(JSON.parse(content)).toEqual({});
  });
});

describe('initCommand already initialized', () => {
  it('throws when .studio/ already exists', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    // First init
    await createStudioStructure(TMP);
    // Second init should throw
    await expect(createStudioStructure(TMP)).rejects.toThrow('already initialized');
  });

  it('error message includes path to the found .studio/', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);
    try {
      await createStudioStructure(TMP);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err instanceof Error && err.message).toContain('.studio');
    }
  });
});

describe('createStudioStructure with templates', () => {
  it('copies template project files when templateName is software', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP, 'software', 'software');

    expect(await exists(resolve(TMP, '.studio', 'projects', 'software', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'software', 'agents', 'coder.agent.yaml'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'software', 'contracts', 'code-output.contract.yaml'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'software', 'tools', 'repo-manager.tool.yaml'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'projects', 'software', 'inputs', 'example.input.yaml'))).toBe(true);
  });

  it('creates empty dirs for blank template (no project/ subdir)', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP, 'blank', 'blank');

    expect(await exists(resolve(TMP, '.studio', 'projects', 'blank', 'pipelines'))).toBe(true);
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(resolve(TMP, '.studio', 'projects', 'blank', 'pipelines'));
    expect(entries).toEqual([]);
  });

  it('throws with helpful message when template does not exist', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await expect(createStudioStructure(TMP, 'xyz', 'xyz')).rejects.toThrow(
      "Template 'xyz' not found"
    );
  });

  it('error message mentions studio templates list', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    try {
      await createStudioStructure(TMP, 'xyz', 'xyz');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err instanceof Error && err.message).toContain('studio templates list');
    }
  });

  it('custom project name with template: copies to named project dir', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP, 'my-app', 'software');

    expect(await exists(resolve(TMP, '.studio', 'projects', 'my-app', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);
  });
});

describe('validateApiKeyFormat', () => {
  it('accepts a valid Anthropic key', async () => {
    const { validateApiKeyFormat } = await import('../../src/commands/init.js');
    expect(validateApiKeyFormat('anthropic', 'sk-ant-api03-abc123')).toBe(true);
  });

  it('rejects an Anthropic key with wrong prefix', async () => {
    const { validateApiKeyFormat } = await import('../../src/commands/init.js');
    const result = validateApiKeyFormat('anthropic', 'sk-wrong-key');
    expect(typeof result).toBe('string'); // returns error message
    expect(result).toContain('sk-ant-');
  });

  it('accepts a valid OpenAI key', async () => {
    const { validateApiKeyFormat } = await import('../../src/commands/init.js');
    expect(validateApiKeyFormat('openai', 'sk-proj-abc123')).toBe(true);
  });

  it('rejects an OpenAI key with wrong prefix', async () => {
    const { validateApiKeyFormat } = await import('../../src/commands/init.js');
    const result = validateApiKeyFormat('openai', 'wrong-key');
    expect(typeof result).toBe('string');
    expect(result).toContain('sk-');
  });

  it('accepts any key for unknown provider', async () => {
    const { validateApiKeyFormat } = await import('../../src/commands/init.js');
    expect(validateApiKeyFormat('later', '')).toBe(true);
  });
});

describe('writeProviderToConfig', () => {
  // We need a fresh .studio/ for each test — reuse the outer TMP/beforeEach/afterEach.

  it('writes anthropic key and defaults to config.yaml', async () => {
    const { createStudioStructure, writeProviderToConfig } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    const studioDir = resolve(TMP, '.studio');
    await writeProviderToConfig(studioDir, 'anthropic', 'sk-ant-test-key');

    const raw = await readFile(resolve(studioDir, 'config.yaml'), 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;

    const providers = parsed.providers as Record<string, { apiKey: string }>;
    expect(providers.anthropic.apiKey).toBe('sk-ant-test-key');

    const defaults = parsed.defaults as { provider: string; model: string };
    expect(defaults.provider).toBe('anthropic');
    expect(defaults.model).toBe('claude-sonnet-4-20250514');
  });

  it('writes openai key and defaults to config.yaml', async () => {
    const { createStudioStructure, writeProviderToConfig } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    const studioDir = resolve(TMP, '.studio');
    await writeProviderToConfig(studioDir, 'openai', 'sk-openai-test-key');

    const raw = await readFile(resolve(studioDir, 'config.yaml'), 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;

    const providers = parsed.providers as Record<string, { apiKey: string }>;
    expect(providers.openai.apiKey).toBe('sk-openai-test-key');

    const defaults = parsed.defaults as { provider: string; model: string };
    expect(defaults.provider).toBe('openai');
    expect(defaults.model).toBe('gpt-4o');
  });

  it('is idempotent — writing twice does not duplicate keys', async () => {
    const { createStudioStructure, writeProviderToConfig } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    const studioDir = resolve(TMP, '.studio');
    await writeProviderToConfig(studioDir, 'anthropic', 'sk-ant-first');
    await writeProviderToConfig(studioDir, 'anthropic', 'sk-ant-second');

    const raw = await readFile(resolve(studioDir, 'config.yaml'), 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, { apiKey: string }>;
    expect(providers.anthropic.apiKey).toBe('sk-ant-second');
  });
});
