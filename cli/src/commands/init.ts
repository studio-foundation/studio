import { mkdir, writeFile, readFile, access, cp, rename } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import * as yaml from 'js-yaml';
import chalk from 'chalk';
import ora from 'ora';
import { input, select, password } from '@inquirer/prompts';
import { findStudioDir } from '../studio-dir.js';
import { listTemplates } from './templates.js';

const TEMPLATES_DIR = resolve(import.meta.dirname, '../../templates');

function formatBackupTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}h${pad(d.getMinutes())}m${pad(d.getSeconds())}s`
  );
}

/**
 * Rename .studio/ to .studio.backup-<timestamp>/ in `cwd`.
 * Returns the absolute path to the backup directory.
 */
export async function backupStudioDir(cwd: string): Promise<string> {
  const studioDir = resolve(cwd, '.studio');
  const backupDir = resolve(cwd, `.studio.backup-${formatBackupTimestamp()}`);
  await rename(studioDir, backupDir);
  return backupDir;
}

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
 * Direct init (non-interactive) — creates structure and writes config.
 * Used when all CLI flags are provided (CI/CD mode).
 */
export async function directInit(
  cwd: string,
  projectName: string,
  templateName: string,
  provider: string,
  apiKey: string
): Promise<void> {
  await createStudioStructure(cwd, projectName, templateName);
  if (provider !== 'later' && apiKey) {
    const studioDir = resolve(cwd, '.studio');
    await writeProviderToConfig(studioDir, provider, apiKey);
  }
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

export async function initCommand(_options: InitOptions = {}): Promise<void> {
  try {
    const cwd = process.cwd();

    // ── Header ──────────────────────────────────────────────
    console.log('');
    console.log(chalk.bold('  ╭─────────────────────────────────╮'));
    console.log(chalk.bold('  │  Studio — Pipeline Creator      │'));
    console.log(chalk.bold('  ╰─────────────────────────────────╯'));
    console.log('');

    // ── Step 1: Project name ────────────────────────────────
    const defaultName = basename(cwd);
    const rawName = await input({
      message: 'Project name:',
      default: defaultName,
    });
    const projectName = rawName.trim() || defaultName;

    // ── Step 2: Description (optional, not persisted) ───────
    await input({
      message: 'Description (optional, press Enter to skip):',
    });

    // ── Step 3: Template ─────────────────────────────────────
    const templates = await listTemplates();
    const templateChoices = templates.map((t) => ({
      value: t.name,
      name: `${t.name} — ${t.description}`,
    }));

    const templateName = await select({
      message: 'Choose a starter template:',
      choices: templateChoices,
    });

    // ── Step 4: Provider ─────────────────────────────────────
    const provider = await select<string>({
      message: 'LLM Provider:',
      choices: [
        { value: 'anthropic', name: 'Anthropic (Claude)' },
        { value: 'openai', name: 'OpenAI (GPT)' },
        { value: 'later', name: 'Configure later' },
      ],
    });

    // ── Step 5: API Key (skipped if "configure later") ───────
    let apiKey: string | undefined;
    if (provider !== 'later') {
      const providerLabel = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
      apiKey = await password({
        message: `${providerLabel} API Key:`,
        validate: (value: string) => validateApiKeyFormat(provider, value),
      });
    }

    // ── Step 6: Create structure ──────────────────────────────
    console.log('');
    const spinner = ora('Creating project...').start();

    const studioDir = resolve(cwd, '.studio');

    try {
      await createStudioStructure(cwd, projectName, templateName);

      if (provider !== 'later' && apiKey) {
        await writeProviderToConfig(studioDir, provider, apiKey);
      }

      spinner.stop();
    } catch (err) {
      spinner.fail('Failed');
      throw err;
    }

    // ── Step 7: Success output ────────────────────────────────
    console.log(chalk.green(`  ✓ .studio/config.yaml`));
    console.log(chalk.green(`  ✓ .studio/projects/${projectName}/`));
    console.log(chalk.green(`  ✓ Copied template files`));
    console.log(chalk.green(`  ✓ Updated .gitignore`));
    console.log('');

    // ── Step 8: Next steps ────────────────────────────────────
    const selectedTemplate = templates.find((t) => t.name === templateName);
    const firstPipeline = selectedTemplate?.pipelines?.[0] ?? 'your-pipeline';

    console.log(chalk.bold('Done! Run your first pipeline:'));
    console.log(
      `  ${chalk.cyan(`studio run ${projectName}/${firstPipeline} --input "..."`)}`
    );
    if (provider === 'later') {
      console.log('');
      console.log('Set your API key first:');
      console.log(
        `  ${chalk.cyan('studio config set provider anthropic --api-key $ANTHROPIC_API_KEY')}`
      );
    }
    console.log('');
  } catch (error) {
    // Graceful exit on Ctrl+C
    if (error instanceof Error && error.name === 'ExitPromptError') {
      console.log('\nAborted.');
      process.exit(0);
    }
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
