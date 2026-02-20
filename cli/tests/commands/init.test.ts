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
    expect(await exists(resolve(TMP, '.studio', 'pipelines'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'agents'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'contracts'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'tools'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'inputs'))).toBe(true);
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

  it('creates flat structure (no projects/ subdir) when templateName is provided', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP, 'software');

    expect(await exists(resolve(TMP, '.studio', 'pipelines'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'agents'))).toBe(true);
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
    await createStudioStructure(TMP, 'software');

    expect(await exists(resolve(TMP, '.studio', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'agents', 'coder.agent.yaml'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'contracts', 'code-output.contract.yaml'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'tools', 'repo-manager.tool.yaml'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'inputs', 'example.input.yaml'))).toBe(true);
  });

  it('creates empty dirs for blank template (no project/ subdir)', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP, 'blank');

    expect(await exists(resolve(TMP, '.studio', 'pipelines'))).toBe(true);
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(resolve(TMP, '.studio', 'pipelines'));
    expect(entries).toEqual([]);
  });

  it('throws with helpful message when template does not exist', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await expect(createStudioStructure(TMP, 'xyz')).rejects.toThrow(
      "Template 'xyz' not found"
    );
  });

  it('error message mentions studio templates list', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    try {
      await createStudioStructure(TMP, 'xyz');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err instanceof Error && err.message).toContain('studio templates list');
    }
  });

  it('flat structure: template files copied directly into .studio/', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP, 'software');

    expect(await exists(resolve(TMP, '.studio', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);
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

describe('backupStudioDir', () => {
  it('moves .studio/ to a backup directory', async () => {
    const { createStudioStructure, backupStudioDir } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    const backupPath = await backupStudioDir(TMP);

    // Original .studio/ is gone
    expect(await exists(resolve(TMP, '.studio'))).toBe(false);
    // Backup dir exists
    expect(await exists(backupPath)).toBe(true);
  });

  it('backup directory name starts with .studio.backup-', async () => {
    const { createStudioStructure, backupStudioDir } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    const backupPath = await backupStudioDir(TMP);
    const backupName = backupPath.split('/').at(-1)!;

    expect(backupName).toMatch(/^\.studio\.backup-\d{4}-\d{2}-\d{2}-\d{2}h\d{2}m\d{2}s$/);
  });

  it('backup preserves files from original .studio/', async () => {
    const { createStudioStructure, backupStudioDir } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    const backupPath = await backupStudioDir(TMP);

    expect(await exists(resolve(backupPath, 'config.yaml'))).toBe(true);
    expect(await exists(resolve(backupPath, 'registry.lock.json'))).toBe(true);
  });

  it('throws if .studio/ does not exist', async () => {
    const { backupStudioDir } = await import('../../src/commands/init.js');
    await expect(backupStudioDir(TMP)).rejects.toThrow();
  });
});

describe('directInit', () => {
  it('creates structure and writes provider config', async () => {
    const { directInit } = await import('../../src/commands/init.js');
    await directInit(TMP, 'software', 'anthropic', 'sk-ant-test-key');

    expect(await exists(resolve(TMP, '.studio', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);

    const raw = await readFile(resolve(TMP, '.studio', 'config.yaml'), 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, { apiKey: string }>;
    expect(providers.anthropic.apiKey).toBe('sk-ant-test-key');
  });

  it('skips writing config when provider is "later"', async () => {
    const { directInit } = await import('../../src/commands/init.js');
    await directInit(TMP, 'software', 'later', '');

    expect(await exists(resolve(TMP, '.studio'))).toBe(true);
    // Config.yaml exists (from template) but has no providers key written by directInit
    const raw = await readFile(resolve(TMP, '.studio', 'config.yaml'), 'utf-8');
    // The template config.yaml has anthropic placeholder but no actual key
    expect(raw).not.toContain('sk-ant-');
  });

  it('throws when template does not exist', async () => {
    const { directInit } = await import('../../src/commands/init.js');
    await expect(
      directInit(TMP, 'nonexistent', 'anthropic', 'sk-ant-key')
    ).rejects.toThrow("Template 'nonexistent' not found");
  });

  it('throws when .studio/ already exists', async () => {
    const { directInit } = await import('../../src/commands/init.js');
    await directInit(TMP, 'software', 'anthropic', 'sk-ant-key');
    await expect(
      directInit(TMP, 'software', 'anthropic', 'sk-ant-key')
    ).rejects.toThrow('already initialized');
  });

  it('works with force: backup then directInit succeeds', async () => {
    const { directInit, backupStudioDir } = await import('../../src/commands/init.js');
    // First init
    await directInit(TMP, 'software', 'anthropic', 'sk-ant-first');
    // Backup + reinit
    await backupStudioDir(TMP);
    await directInit(TMP, 'software', 'anthropic', 'sk-ant-second');

    const raw = await readFile(resolve(TMP, '.studio', 'config.yaml'), 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, { apiKey: string }>;
    expect(providers.anthropic.apiKey).toBe('sk-ant-second');
  });
});

describe('createStudioStructure with withTools: false', () => {
  it('does not copy tool files from template', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP, 'software', false);

    const toolsDir = resolve(TMP, '.studio', 'tools');
    expect(await exists(toolsDir)).toBe(true);

    const { readdir } = await import('node:fs/promises');
    const toolFiles = await readdir(toolsDir);
    expect(toolFiles).toEqual([]);
  });

  it('still copies other template files when withTools is false', async () => {
    const { createStudioStructure } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP, 'software', false);

    expect(await exists(resolve(TMP, '.studio', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);
    expect(await exists(resolve(TMP, '.studio', 'agents', 'coder.agent.yaml'))).toBe(true);
  });
});

describe('directInit with noTools: true', () => {
  it('creates project without copying tool files', async () => {
    const { directInit } = await import('../../src/commands/init.js');
    await directInit(TMP, 'software', 'anthropic', 'sk-ant-key', true);

    const toolsDir = resolve(TMP, '.studio', 'tools');
    expect(await exists(toolsDir)).toBe(true);

    const { readdir } = await import('node:fs/promises');
    const toolFiles = await readdir(toolsDir);
    expect(toolFiles).toEqual([]);
  });

  it('still creates config.yaml when noTools is true', async () => {
    const { directInit } = await import('../../src/commands/init.js');
    await directInit(TMP, 'software', 'anthropic', 'sk-ant-key', true);

    expect(await exists(resolve(TMP, '.studio', 'config.yaml'))).toBe(true);
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

describe('generateAppFiles', () => {
  it('copies src/ with placeholder replacement', async () => {
    const { generateAppFiles } = await import('../../src/commands/init.js');
    const templateDir = new URL('../../templates/projects/software', import.meta.url).pathname;

    await generateAppFiles(templateDir, TMP, {
      PROJECT_NAME: 'my-app',
      TEMPLATE_NAME: 'software',
      YEAR: '2026',
    });

    const srcIndex = await readFile(resolve(TMP, 'src', 'index.ts'), 'utf-8');
    expect(srcIndex).toContain('my-app');
    expect(srcIndex).not.toContain('{{PROJECT_NAME}}');
  });

  it('copies package.json with placeholder replacement', async () => {
    const { generateAppFiles } = await import('../../src/commands/init.js');
    const templateDir = new URL('../../templates/projects/software', import.meta.url).pathname;

    await generateAppFiles(templateDir, TMP, {
      PROJECT_NAME: 'cool-project',
      TEMPLATE_NAME: 'software',
      YEAR: '2026',
    });

    const pkg = JSON.parse(await readFile(resolve(TMP, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('cool-project');
  });

  it('copies README.md with placeholder replacement', async () => {
    const { generateAppFiles } = await import('../../src/commands/init.js');
    const templateDir = new URL('../../templates/projects/software', import.meta.url).pathname;

    await generateAppFiles(templateDir, TMP, {
      PROJECT_NAME: 'my-app',
      TEMPLATE_NAME: 'software',
      YEAR: '2026',
    });

    const readme = await readFile(resolve(TMP, 'README.md'), 'utf-8');
    expect(readme).toContain('my-app');
    expect(readme).toContain('software');
    expect(readme).not.toContain('{{PROJECT_NAME}}');
  });

  it('copies prisma/schema.prisma', async () => {
    const { generateAppFiles } = await import('../../src/commands/init.js');
    const templateDir = new URL('../../templates/projects/software', import.meta.url).pathname;

    await generateAppFiles(templateDir, TMP, {
      PROJECT_NAME: 'my-app',
      TEMPLATE_NAME: 'software',
      YEAR: '2026',
    });

    expect(await exists(resolve(TMP, 'prisma', 'schema.prisma'))).toBe(true);
  });

  it('skips items not present in template (blank template has no src/)', async () => {
    const { generateAppFiles } = await import('../../src/commands/init.js');
    const templateDir = new URL('../../templates/projects/blank', import.meta.url).pathname;

    await expect(
      generateAppFiles(templateDir, TMP, {
        PROJECT_NAME: 'x',
        TEMPLATE_NAME: 'blank',
        YEAR: '2026',
      })
    ).resolves.not.toThrow();

    // blank template has no src/ so it should not be created
    expect(await exists(resolve(TMP, 'src'))).toBe(false);
  });

  it('returns list of generated top-level items', async () => {
    const { generateAppFiles } = await import('../../src/commands/init.js');
    const templateDir = new URL('../../templates/projects/software', import.meta.url).pathname;

    const generated = await generateAppFiles(templateDir, TMP, {
      PROJECT_NAME: 'my-app',
      TEMPLATE_NAME: 'software',
      YEAR: '2026',
    });

    expect(generated).toContain('package.json');
    expect(generated).toContain('README.md');
    expect(generated).toContain('src/');    // directories have trailing slash
    expect(generated).toContain('prisma/'); // directories have trailing slash
  });
});

describe('initGitRepo', () => {
  it('creates a .git/ directory in cwd', async () => {
    const { initGitRepo } = await import('../../src/commands/init.js');
    await initGitRepo(TMP);
    expect(await exists(resolve(TMP, '.git'))).toBe(true);
  });

  it('returns true when it initializes git', async () => {
    const { initGitRepo } = await import('../../src/commands/init.js');
    const result = await initGitRepo(TMP);
    expect(result).toBe(true);
  });

  it('returns false (skips) when .git/ already exists', async () => {
    const { initGitRepo } = await import('../../src/commands/init.js');
    await initGitRepo(TMP);
    const result = await initGitRepo(TMP);
    expect(result).toBe(false);
  });
});

describe('generateFullApp', () => {
  it('creates .studio/ AND src/ AND package.json AND README.md', async () => {
    const { generateFullApp } = await import('../../src/commands/init.js');
    await generateFullApp(TMP, 'my-app', 'software');

    expect(await exists(resolve(TMP, '.studio', 'pipelines'))).toBe(true);
    expect(await exists(resolve(TMP, 'src', 'index.ts'))).toBe(true);
    expect(await exists(resolve(TMP, 'package.json'))).toBe(true);
    expect(await exists(resolve(TMP, 'README.md'))).toBe(true);
    expect(await exists(resolve(TMP, 'prisma', 'schema.prisma'))).toBe(true);
  });

  it('applies PROJECT_NAME placeholder in package.json', async () => {
    const { generateFullApp } = await import('../../src/commands/init.js');
    await generateFullApp(TMP, 'cool-app', 'software');

    const pkg = JSON.parse(await readFile(resolve(TMP, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('cool-app');
  });

  it('initializes a git repository', async () => {
    const { generateFullApp } = await import('../../src/commands/init.js');
    const result = await generateFullApp(TMP, 'my-app', 'software');
    expect(result.gitInitialized).toBe(true);
    expect(await exists(resolve(TMP, '.git'))).toBe(true);
  });

  it('throws when template does not exist', async () => {
    const { generateFullApp } = await import('../../src/commands/init.js');
    await expect(generateFullApp(TMP, 'my-app', 'nonexistent-template')).rejects.toThrow();
  });

  it('skips git init when skipGit option is true', async () => {
    const { generateFullApp } = await import('../../src/commands/init.js');
    const result = await generateFullApp(TMP, 'my-app', 'software', { skipGit: true });
    expect(result.gitInitialized).toBe(false);
    expect(await exists(resolve(TMP, '.git'))).toBe(false);
    expect(await exists(resolve(TMP, '.studio'))).toBe(true);
  });
});

describe('validateProjectName', () => {
  it('accepts valid names', async () => {
    const { validateProjectName } = await import('../../src/commands/init.js');
    expect(validateProjectName('my-app')).toBe(true);
    expect(validateProjectName('my_project')).toBe(true);
    expect(validateProjectName('MyApp123')).toBe(true);
    expect(validateProjectName('app.v2')).toBe(true);
  });

  it('rejects empty string', async () => {
    const { validateProjectName } = await import('../../src/commands/init.js');
    expect(validateProjectName('')).toBeTypeOf('string');
  });

  it('rejects names with spaces or tabs', async () => {
    const { validateProjectName } = await import('../../src/commands/init.js');
    expect(validateProjectName('my app')).toBeTypeOf('string');
    expect(validateProjectName('my\tapp')).toBeTypeOf('string');
  });

  it('rejects names starting with a hyphen', async () => {
    const { validateProjectName } = await import('../../src/commands/init.js');
    const result = validateProjectName('-bad');
    expect(result).toBeTypeOf('string');
    expect(result as string).toContain('letter or digit');
  });

  it('rejects names with special characters', async () => {
    const { validateProjectName } = await import('../../src/commands/init.js');
    expect(validateProjectName('my@app')).toBeTypeOf('string');
    expect(validateProjectName('app!')).toBeTypeOf('string');
    expect(validateProjectName('app/dir')).toBeTypeOf('string');
  });

  it('rejects whitespace-only names', async () => {
    const { validateProjectName } = await import('../../src/commands/init.js');
    expect(validateProjectName('   ')).toBeTypeOf('string');
  });

  it('rejects names starting with a dot', async () => {
    const { validateProjectName } = await import('../../src/commands/init.js');
    expect(validateProjectName('.hidden')).toBeTypeOf('string');
  });
});
