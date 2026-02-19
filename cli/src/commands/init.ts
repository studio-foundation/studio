import { mkdir, writeFile, readFile, access, rename } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import * as yaml from 'js-yaml';
import chalk from 'chalk';
import ora from 'ora';
import { input, select, password, confirm } from '@inquirer/prompts';
import { findStudioDir } from '../studio-dir.js';
import { listTemplates } from './templates.js';
import { createProjectDir } from './project.js';
import { validateApiKeyLive } from '../provider-validator.js';
import { getAvailableModels } from '../models-cache.js';

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

/**
 * Create the full .studio/ directory structure in `cwd`.
 * If templateName is provided, copies the template's project/ subdir.
 * Throws if .studio/ already exists anywhere in the directory tree.
 */
export async function createStudioStructure(
  cwd: string,
  projectName = 'default',
  templateName?: string,
  withTools = true
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
  const projectsDir = join(studioDir, 'projects');
  await mkdir(projectsDir, { recursive: true });
  await createProjectDir(projectsDir, projectName, templateName, { withTools });

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
  apiKey: string,
  model?: string
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
    model: model ?? DEFAULT_MODELS[provider] ?? 'claude-sonnet-4-20250514',
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
  apiKey: string,
  noTools = false
): Promise<void> {
  await createStudioStructure(cwd, projectName, templateName, !noTools);
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
  provider?: string;
  apiKey?: string;
  force?: boolean;
  yes?: boolean;
}

export async function initCommand(nameArg?: string, options: InitOptions = {}): Promise<void> {
  try {
    const cwd = process.cwd();

    // ── Exists detection ──────────────────────────────────────────────
    const existing = await findStudioDir(cwd);

    if (existing && !options.force) {
      console.error(chalk.red('  ✗ Studio is already initialized in this directory.'));
      console.log('');
      console.log('To reconfigure:');
      console.log(`  ${chalk.cyan('studio config add-provider')}     # Add/update LLM provider`);
      console.log(`  ${chalk.cyan('studio tools add')}               # Install additional tools`);
      console.log(`  ${chalk.cyan('studio project add')}             # Create new project`);
      console.log('');
      console.log('To start fresh:');
      console.log(`  ${chalk.cyan('studio init --force')}            # ⚠ Backs up existing config`);
      process.exit(1);
    }

    // ── Force: backup existing .studio/ ──────────────────────────────
    if (existing && options.force) {
      if (!options.yes) {
        const confirmed = await confirm({
          message: '⚠ This will backup your existing .studio/ directory. Continue?',
          default: false,
        });
        if (!confirmed) {
          console.log('Aborted.');
          process.exit(0);
        }
      }
      const backupPath = await backupStudioDir(cwd);
      const backupName = backupPath.split('/').at(-1)!;
      console.log('');
      console.log(chalk.green(`  ✓ Backed up to ${backupName}/`));
      console.log('');
    }

    // ── Direct mode (all flags provided) vs Wizard ────────────────────
    const isDirectMode = !!(options.template && options.provider);

    if (isDirectMode) {
      // Validate required flags
      if (options.provider !== 'later' && !options.apiKey) {
        console.error('Error: --api-key is required when --provider is not "later"');
        process.exit(1);
      }
      if (options.provider !== 'later' && options.apiKey) {
        const validation = validateApiKeyFormat(options.provider!, options.apiKey);
        if (validation !== true) {
          console.error(`Error: ${validation}`);
          process.exit(1);
        }
        process.stdout.write('Validating API key...');
        const result = await validateApiKeyLive(options.provider!, options.apiKey);
        if (result.status === 'valid') {
          console.log(chalk.green(' ✓'));
        } else if (result.status === 'warning') {
          console.log(chalk.yellow(` ⚠ ${result.message}`));
        } else {
          console.error(chalk.red(` ✗ ${result.error}`));
          process.exit(1);
        }
      }

      const projectName = nameArg ?? options.project ?? basename(cwd);
      const spinner = ora('Creating project...').start();

      try {
        await directInit(cwd, projectName, options.template!, options.provider!, options.apiKey ?? '');
        spinner.stop();
      } catch (err) {
        spinner.fail('Failed');
        throw err;
      }

      console.log(chalk.green(`  ✓ .studio/config.yaml`));
      console.log(chalk.green(`  ✓ .studio/projects/${projectName}/`));
      console.log(chalk.green(`  ✓ Applied template: ${options.template}`));
      console.log(chalk.green(`  ✓ Updated .gitignore`));
      console.log('');

      const templates = await listTemplates();
      const selectedTemplate = templates.find((t) => t.name === options.template);
      const firstPipeline = selectedTemplate?.pipelines?.[0] ?? 'your-pipeline';

      console.log(chalk.bold('Done! Run your first pipeline:'));
      console.log(`  ${chalk.cyan(`studio run ${projectName}/${firstPipeline} --input "..."`)}`);
      if (options.provider === 'later') {
        console.log('');
        console.log('Set your API key first:');
        console.log(
          `  ${chalk.cyan('studio config set provider anthropic --api-key $ANTHROPIC_API_KEY')}`
        );
      }
      console.log('');
      return;
    }

    // ── Wizard mode ───────────────────────────────────────────────────
    console.log('');
    console.log(chalk.bold('  ╭─────────────────────────────────╮'));
    console.log(chalk.bold('  │  Studio — Pipeline Creator      │'));
    console.log(chalk.bold('  ╰─────────────────────────────────╯'));
    console.log('');

    // Step 1: Project name
    const defaultName = nameArg ?? options.project ?? basename(cwd);
    const rawName = await input({
      message: 'Project name:',
      default: defaultName,
    });
    const projectName = rawName.trim() || defaultName;

    // Step 2: Description (optional, not persisted)
    await input({
      message: 'Description (optional, press Enter to skip):',
    });

    // Step 3: Template
    const templates = await listTemplates();
    const templateChoices = templates.map((t) => ({
      value: t.name,
      name: `${t.name} — ${t.description}`,
    }));

    const templateName = await select({
      message: 'Choose a starter template:',
      choices: templateChoices,
    });

    // Step 4: Provider
    const provider = await select<string>({
      message: 'LLM Provider:',
      choices: [
        { value: 'anthropic', name: 'Anthropic (Claude)' },
        { value: 'openai', name: 'OpenAI (GPT)' },
        { value: 'later', name: 'Configure later' },
      ],
    });

    // Step 5: API Key
    let apiKey: string | undefined;
    if (provider !== 'later') {
      const providerLabel = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
      while (true) {
        apiKey = await password({
          message: `${providerLabel} API Key:`,
          validate: (value: string) => validateApiKeyFormat(provider, value),
        });
        const spinner = ora('Validating...').start();
        const result = await validateApiKeyLive(provider, apiKey);
        spinner.stop();
        if (result.status === 'valid') {
          console.log(chalk.green('  ✓ Valid'));
          break;
        } else if (result.status === 'warning') {
          console.log(chalk.yellow(`  ⚠ ${result.message}`));
          break;
        } else {
          console.log(chalk.red(`  ✗ ${result.error}`));
          console.log(chalk.gray('  Please try again.'));
        }
      }
    }

    // Step 5b: Choose default model
    let selectedModel: string | undefined;
    if (provider !== 'later' && apiKey) {
      const models = await getAvailableModels(provider, apiKey);
      const fallback = DEFAULT_MODELS[provider] ?? 'claude-sonnet-4-20250514';

      if (models.length > 0) {
        const choices = [
          ...models.map((m) => ({ value: m, name: m })),
          { value: '__custom__', name: 'Enter custom model ID' },
        ];
        const chosen = await select<string>({
          message: 'Default model:',
          choices,
          default: models.includes(fallback) ? fallback : models[0],
        });
        if (chosen === '__custom__') {
          selectedModel = await input({ message: 'Model ID:', default: fallback });
        } else {
          selectedModel = chosen;
        }
      } else {
        selectedModel = await input({ message: 'Default model:', default: fallback });
      }
    }

    // Step 6: Create structure
    console.log('');
    const spinner = ora('Creating project...').start();

    const studioDir = resolve(cwd, '.studio');

    try {
      await createStudioStructure(cwd, projectName, templateName);

      if (provider !== 'later' && apiKey) {
        await writeProviderToConfig(studioDir, provider, apiKey, selectedModel);
      }

      spinner.stop();
    } catch (err) {
      spinner.fail('Failed');
      throw err;
    }

    // Step 7: Success output
    console.log(chalk.green(`  ✓ .studio/config.yaml`));
    console.log(chalk.green(`  ✓ .studio/projects/${projectName}/`));
    console.log(chalk.green(`  ✓ Copied template files`));
    console.log(chalk.green(`  ✓ Updated .gitignore`));
    console.log('');

    // Step 8: Next steps
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
