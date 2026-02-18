import { mkdir, writeFile, readFile, access, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import * as yaml from 'js-yaml';
import chalk from 'chalk';
import { findStudioDir } from '../studio-dir.js';

const TEMPLATES_DIR = resolve(import.meta.dirname, '../../templates');

const GITIGNORE_ENTRIES = ['.studio/config.yaml', '.studio/runs/'];

const PROJECT_SUBDIRS = ['pipelines', 'agents', 'contracts', 'tools', 'inputs'];

/**
 * Create the full .studio/ directory structure in `cwd`.
 * If templateName is provided, copies the template's project/ subdir.
 * Throws if .studio/ already exists anywhere in the directory tree.
 */
export async function createStudioStructure(
  cwd: string,
  projectName = 'default',
  templateName?: string
): Promise<void> {
  // Check if already initialized
  const existing = await findStudioDir(cwd);
  if (existing) {
    throw new Error(
      `Studio is already initialized at ${existing}\n` +
        `If you want to reinitialize, delete the .studio/ directory first.`
    );
  }

  const studioDir = resolve(cwd, '.studio');
  const projectDir = join(studioDir, 'projects', projectName);

  if (templateName) {
    const templateDir = resolve(TEMPLATES_DIR, 'projects', templateName);

    // Verify template exists
    const templateExists = await access(templateDir).then(() => true).catch(() => false);
    if (!templateExists) {
      throw new Error(
        `Template '${templateName}' not found. Run 'studio templates list' to see available templates.`
      );
    }

    // Copy project/ subdir if present, otherwise create empty dirs
    const templateProjectDir = join(templateDir, 'project');
    const hasProjectDir = await access(templateProjectDir).then(() => true).catch(() => false);

    if (hasProjectDir) {
      await mkdir(projectDir, { recursive: true });
      await cp(templateProjectDir, projectDir, { recursive: true });
    } else {
      for (const sub of PROJECT_SUBDIRS) {
        await mkdir(join(projectDir, sub), { recursive: true });
      }
    }
  } else {
    // No template — create empty subdirectories
    for (const sub of PROJECT_SUBDIRS) {
      await mkdir(join(projectDir, sub), { recursive: true });
    }
  }

  // Create runs/logs/
  await mkdir(join(studioDir, 'runs', 'logs'), { recursive: true });

  // Write registry.lock.json (empty, committed)
  await writeFile(join(studioDir, 'registry.lock.json'), '{}\n', 'utf-8');

  // Copy config template (only if config.yaml doesn't already exist)
  const configPath = join(studioDir, 'config.yaml');
  const configExists = await access(configPath)
    .then(() => true)
    .catch(() => false);
  if (!configExists) {
    const template = await readFile(resolve(TEMPLATES_DIR, 'studio-config.yaml'), 'utf-8');
    await writeFile(configPath, template, 'utf-8');
  }

  // Update .gitignore
  await updateGitignore(cwd);
}

async function updateGitignore(cwd: string): Promise<void> {
  const gitignorePath = resolve(cwd, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(gitignorePath, 'utf-8');
  } catch {
    // file doesn't exist yet
  }

  const toAdd = GITIGNORE_ENTRIES.filter((entry) => !existing.includes(entry));
  if (toAdd.length === 0) return;

  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const addition = '\n# Studio (generated)\n' + toAdd.join('\n') + '\n';
  await writeFile(gitignorePath, existing + separator + addition, 'utf-8');
}

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
};

/**
 * Write provider credentials and defaults into .studio/config.yaml.
 * Parses the existing config, sets the provider key, then rewrites.
 * Comments from the original template are lost — accepted for Phase 1.
 */
export async function writeProviderToConfig(
  studioDir: string,
  provider: string,
  apiKey: string
): Promise<void> {
  const configPath = join(studioDir, 'config.yaml');

  let raw = '';
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch {
    // Config doesn't exist yet — start from empty
  }

  const parsed = ((yaml.load(raw) ?? {}) as Record<string, unknown>);

  // Set provider key
  if (!parsed.providers || typeof parsed.providers !== 'object') {
    parsed.providers = {};
  }
  (parsed.providers as Record<string, unknown>)[provider] = { apiKey };

  // Set defaults
  parsed.defaults = {
    provider,
    model: DEFAULT_MODELS[provider] ?? 'claude-sonnet-4-20250514',
  };

  await writeFile(configPath, yaml.dump(parsed), 'utf-8');
}

/**
 * Validate API key format without making a network call.
 * Returns true if valid, or an error string to display.
 */
export function validateApiKeyFormat(provider: string, key: string): true | string {
  if (provider === 'anthropic') {
    if (!key.startsWith('sk-ant-')) {
      return 'Anthropic API keys must start with sk-ant-';
    }
  } else if (provider === 'openai') {
    if (!key.startsWith('sk-')) {
      return 'OpenAI API keys must start with sk-';
    }
  }
  return true;
}

interface InitOptions {
  template?: string;
  project?: string;
}

export async function initCommand(options: InitOptions = {}): Promise<void> {
  try {
    const cwd = process.cwd();
    const templateName = options.template;
    const projectName = options.project ?? options.template ?? 'default';

    console.log(chalk.blue('\nInitializing Studio project...\n'));

    await createStudioStructure(cwd, projectName, templateName);

    console.log(chalk.gray(`  Created .studio/config.yaml`));
    console.log(
      chalk.gray(
        `  Created .studio/projects/${projectName}/{pipelines,agents,contracts,tools,inputs}/`
      )
    );
    console.log(chalk.gray(`  Created .studio/runs/logs/`));
    console.log(chalk.gray(`  Created .studio/registry.lock.json`));
    console.log(chalk.gray(`  Updated .gitignore`));
    console.log(chalk.green('\n✓ Studio project initialized'));
    console.log('');
    console.log('Next steps:');
    console.log(`  1. Set your API key: ${chalk.cyan('export ANTHROPIC_API_KEY=...')}`);
    console.log(
      `  2. Or: ${chalk.cyan('studio config set provider anthropic --api-key $ANTHROPIC_API_KEY')}`
    );
    console.log(
      `  3. Add your pipeline configs to: ${chalk.cyan(`.studio/projects/${projectName}/`)}`
    );
    console.log(
      `  4. Run: ${chalk.cyan(`studio run ${projectName}/my-pipeline --input "Hello!"`)}`
    );
    console.log('');
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
