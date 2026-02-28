import { mkdir, writeFile, readFile, access, rename, readdir, lstat, copyFile, cp } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import chalk from 'chalk';
import ora from 'ora';
import { input, select, password, confirm, checkbox } from '@inquirer/prompts';
import { findStudioDir } from '../studio-dir.js';
import { applyPlaceholders } from '../utils/placeholders.js';
import { listTemplates, type TemplateMetadata } from './templates.js';
import { validateApiKeyLive } from '../provider-validator.js';
import { getAvailableModels } from '../models-cache.js';
import { toolsAddDirect } from './tools.js';
import { listAvailableToolTemplates } from '@studio/runner';
import { validateTemplateDir } from './template/validate.js';
import { installPackage } from './registry/install.js';

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

const STUDIO_SUBDIRS = ['pipelines', 'agents', 'contracts', 'tools', 'inputs'];

/**
 * Create or populate .studio/ with subdirs.
 * If templateName is provided, copies content from the template root (flat — no project/ subdir).
 * If withTools is false, creates an empty tools/ dir instead of copying from template.
 */
async function copyTemplateToStudio(
  studioDir: string,
  templateName?: string,
  options: { withTools?: boolean } = {}
): Promise<void> {
  const withTools = options.withTools ?? true;

  if (templateName) {
    const templateDir = resolve(TEMPLATES_DIR, 'projects', templateName);
    const templateExists = await access(templateDir).then(() => true).catch(() => false);
    if (!templateExists) {
      throw new Error(
        `Template '${templateName}' not found. Run 'studio templates list' to see available templates.`
      );
    }

    await mkdir(studioDir, { recursive: true });

    // Copy only the studio-specific subdirs into .studio/ — never the app scaffold
    // files (src/, prisma/, package.json, README.md); those are handled by generateAppFiles.
    for (const sub of STUDIO_SUBDIRS) {
      if (!withTools && sub === 'tools') continue;
      const srcDir = join(templateDir, sub);
      const destDir = join(studioDir, sub);
      const srcExists = await access(srcDir).then(() => true).catch(() => false);
      if (srcExists) {
        await cp(srcDir, destDir, { recursive: true });
      }
      // Always ensure the subdir exists even if the template doesn't include it
      await mkdir(destDir, { recursive: true });
    }
    if (!withTools) {
      await mkdir(join(studioDir, 'tools'), { recursive: true });
    }
  } else {
    for (const sub of STUDIO_SUBDIRS) {
      await mkdir(join(studioDir, sub), { recursive: true });
    }
  }
}

/**
 * Create the full .studio/ directory structure in `cwd`.
 * If templateName is provided, copies the template files directly into .studio/ (flat structure).
 * Throws if .studio/ already exists anywhere in the directory tree.
 */
export async function createStudioStructure(
  cwd: string,
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
  await copyTemplateToStudio(studioDir, templateName, { withTools });

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
 * Direct init (non-interactive) — creates .studio/ structure and writes config.
 * @deprecated Use generateFullApp() for full app generation (src/, prisma/, git init).
 * This function only creates the .studio/ workspace without app scaffold files.
 * Kept for backward compatibility.
 */
export async function directInit(
  cwd: string,
  templateName: string,
  provider: string,
  apiKey: string,
  noTools = false
): Promise<void> {
  await createStudioStructure(cwd, templateName, !noTools);
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

/**
 * Validate a project name for use as a directory name.
 * Returns true if valid, or an error string to display.
 */
export function validateProjectName(name: string): true | string {
  if (!name.trim()) return 'Project name cannot be empty';
  if (/\s/.test(name)) return 'Project name cannot contain spaces';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9\-_.]*$/.test(name))
    return 'Project name must start with a letter or digit and contain only letters, digits, hyphens, underscores, or dots';
  return true;
}

// App scaffold items to copy from template root → target root
const APP_SCAFFOLD_ITEMS = ['src', 'prisma', 'package.json', 'README.md'];

/**
 * Copy app scaffold files (src/, prisma/, package.json, README.md) from
 * `templateDir` to `targetDir`, applying placeholder replacement to all
 * text file contents. Items missing from the template are silently skipped.
 *
 * @returns List of top-level items that were generated (e.g. ['src/', 'package.json'])
 */
export async function generateAppFiles(
  templateDir: string,
  targetDir: string,
  vars: Record<string, string>
): Promise<string[]> {
  const generated: string[] = [];

  for (const item of APP_SCAFFOLD_ITEMS) {
    const src = join(templateDir, item);
    const dest = join(targetDir, item);

    let stat;
    try {
      stat = await lstat(src);
    } catch {
      continue; // Not present in this template — skip
    }

    if (stat.isDirectory()) {
      await copyDirWithPlaceholders(src, dest, vars);
      generated.push(item + '/');
    } else {
      const content = await readFile(src, 'utf-8');
      const replaced = applyPlaceholders(content, vars);
      await writeFile(dest, replaced, 'utf-8');
      generated.push(item);
    }
  }

  return generated;
}

const TEXT_EXTENSIONS = new Set([
  '.ts', '.js', '.json', '.md', '.yaml', '.yml',
  '.prisma', '.txt', '.env', '.gitignore', '.sh',
]);

/**
 * Recursively copy a directory, applying placeholder replacement to known text
 * file extensions. All other files (binary or unknown) are copied as-is.
 */
async function copyDirWithPlaceholders(
  src: string,
  dest: string,
  vars: Record<string, string>
): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirWithPlaceholders(srcPath, destPath, vars);
    } else {
      const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop()! : '';
      if (TEXT_EXTENSIONS.has(ext)) {
        const content = await readFile(srcPath, 'utf-8');
        const replaced = applyPlaceholders(content, vars);
        await writeFile(destPath, replaced, 'utf-8');
      } else {
        await copyFile(srcPath, destPath);
      }
    }
  }
}

/**
 * Run `git init` in `cwd` unless `.git/` already exists.
 * Returns true if git was initialized, false if skipped.
 * Throws if `git init` exits with non-zero status.
 */
export async function initGitRepo(cwd: string): Promise<boolean> {
  const gitDir = join(cwd, '.git');
  const alreadyGit = await access(gitDir).then(() => true).catch(() => false);
  if (alreadyGit) return false;

  const result = spawnSync('git', ['init'], { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    throw new Error(`git init failed: ${stderr}`);
  }
  return true;
}

interface GenerateFullAppOptions {
  noTools?: boolean;
  skipGit?: boolean;
}

/**
 * Generate a complete app from a template:
 * 1. Installs the template from the registry to .studio/projects/<name>/
 * 2. Creates .studio/ workspace
 * 3. Copies app scaffold files (src/, prisma/, package.json, README.md) from the installed template
 * 4. Initializes a git repository (unless skipGit)
 *
 * Does NOT write provider config — call writeProviderToConfig separately.
 *
 * @returns `{ gitInitialized, generatedFiles }` — gitInitialized is true if git was initialized,
 *          generatedFiles is the list of top-level scaffold items actually created (e.g. ['src/', 'package.json']).
 */
export async function generateFullApp(
  cwd: string,
  projectName: string,
  templateName: string,
  options: GenerateFullAppOptions = {}
): Promise<{ gitInitialized: boolean; generatedFiles: string[] }> {
  const studioDir = resolve(cwd, '.studio');

  // 1. Create .studio/ workspace (flat — no projects/<name>/ layer)
  await createStudioStructure(cwd, templateName, !options.noTools);

  // 2. Install template from registry to .studio/projects/<templateName>/
  await installPackage(templateName, { studioDir, force: false });

  // 3. Copy app scaffold files from installed template to project root with placeholder replacement
  const installedTemplateDir = resolve(studioDir, 'projects', templateName);
  const vars = {
    PROJECT_NAME: projectName,
    TEMPLATE_NAME: templateName,
    YEAR: String(new Date().getFullYear()),
  };
  const generatedFiles = await generateAppFiles(installedTemplateDir, cwd, vars);

  // 4. Initialize git repo (unless already initialized or skipped)
  let gitInitialized = false;
  if (!options.skipGit) {
    gitInitialized = await initGitRepo(cwd);
  }

  return { gitInitialized, generatedFiles };
}

interface InitOptions {
  template?: string;
  project?: string;
  provider?: string;
  apiKey?: string;
  force?: boolean;
  yes?: boolean;
  tools?: boolean;  // false when --no-tools is passed, true otherwise
}

function detectPackageManager(): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  const check = (cmd: string) =>
    spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
  if (check('pnpm')) return 'pnpm';
  if (check('yarn')) return 'yarn';
  if (check('bun')) return 'bun';
  return 'npm';
}

function printTemplateCard(template: TemplateMetadata): void {
  const lines: string[] = [template.description];
  if (template.pipelines?.length) {
    lines.push(`Pipelines: ${template.pipelines.join(', ')}`);
  }
  if (template.tools_included?.length) {
    lines.push(`Tools:     ${template.tools_included.join(', ')}`);
  }
  const minWidth = `─ ${template.name} `.length;
  const innerWidth = Math.max(minWidth, ...lines.map((l) => l.length));
  const bar = '─'.repeat(innerWidth + 4);
  const templateLabel = `─ ${template.name} `;
  const rightBar = '─'.repeat(Math.max(0, bar.length - templateLabel.length));
  console.log('');
  console.log(`  ${templateLabel}${rightBar}`);
  for (const line of lines) {
    console.log(`  │  ${line}`);
  }
  console.log(`  ${bar}`);
  console.log('');
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

      const spinner = ora('Creating project...').start();

      let gitInitialized = false;
      let generatedFiles: string[] = [];
      try {
        const projectName = nameArg ?? options.project ?? basename(cwd);
        ({ gitInitialized, generatedFiles } = await generateFullApp(cwd, projectName, options.template!, {
          noTools: options.tools === false,
        }));
        if (options.provider !== 'later' && options.apiKey) {
          const studioDir = resolve(cwd, '.studio');
          await writeProviderToConfig(studioDir, options.provider!, options.apiKey);
        }
        spinner.stop();
      } catch (err) {
        spinner.fail('Failed');
        throw err;
      }

      console.log(chalk.green(`  ✓ .studio/config.yaml`));
      console.log(chalk.green(`  ✓ .studio/pipelines/`));
      for (const f of generatedFiles) {
        console.log(chalk.green(`  ✓ ${f}`));
      }
      if (gitInitialized) {
        console.log(chalk.green(`  ✓ git initialized`));
      }
      console.log(chalk.green(`  ✓ Updated .gitignore`));
      console.log('');

      const templates = await listTemplates();
      const selectedTemplate = templates.find((t) => t.name === options.template);
      const firstPipeline = selectedTemplate?.pipelines?.[0] ?? 'your-pipeline';

      console.log(chalk.bold('Done! Next steps:'));
      console.log(`  ${chalk.cyan('npm install')}`);
      console.log(`  ${chalk.cyan(`studio run ${firstPipeline} --input "..."`)}`);
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

    // Non-interactive terminal fallback
    if (!process.stdin.isTTY) {
      console.error('stdin is not a TTY. Use flags for non-interactive init:');
      console.error('  studio init --template <type> --name <project> --provider <provider> --api-key <key>');
      process.exit(1);
    }

    console.log('');
    console.log(chalk.bold('  ╭─────────────────────────────────╮'));
    console.log(chalk.bold('  │  Studio — Create App            │'));
    console.log(chalk.bold('  ╰─────────────────────────────────╯'));
    console.log('');

    // Step 1: Template selection (first — drives everything else)
    const templates = await listTemplates();
    const templateChoices = templates.map((t) => ({
      value: t.name,
      name: `${t.name} — ${t.description}`,
    }));

    const templateName = await select({
      message: 'What type of app are you building?',
      choices: templateChoices,
    });

    // Show template details card
    const selectedTemplateMeta = templates.find((t) => t.name === templateName);
    if (selectedTemplateMeta) {
      printTemplateCard(selectedTemplateMeta);
    }

    // Step 2: Project name (with validation)
    const defaultName = nameArg ?? options.project ?? basename(cwd);
    const projectName = await input({
      message: 'Project name:',
      default: defaultName,
      validate: validateProjectName,
    });

    // Step 3: Provider
    const provider = await select<string>({
      message: 'LLM Provider:',
      choices: [
        { value: 'anthropic', name: 'Anthropic (Claude)' },
        { value: 'openai', name: 'OpenAI (GPT)' },
        { value: 'later', name: 'Configure later' },
      ],
    });

    // Step 4: API Key
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

    // Step 5: Choose default model
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

    // Step 6: Tool selection
    const availableTools = await listAvailableToolTemplates();
    let selectedTools: string[] = [];

    if (availableTools.length > 0) {
      const recommended = new Set(selectedTemplateMeta?.tools_included ?? []);

      const toolChoices = availableTools.map((t) => ({
        value: t.name,
        name: `${t.name} — ${t.description}`,
        checked: recommended.has(t.name),
      }));

      console.log('');
      selectedTools = await checkbox({
        message: 'Select tools to install:',
        choices: toolChoices,
      });
    }

    // Step 7: Install dependencies preference
    const pkgManager = detectPackageManager();
    const installNow = await confirm({
      message: `Install dependencies now? (uses ${pkgManager})`,
      default: false,
    });

    // Step 8: Generate app (without tools — we install them below)
    console.log('');
    const spinner = ora('Creating project...').start();

    const studioDir = resolve(cwd, '.studio');

    let gitInitialized = false;
    let generatedFiles: string[] = [];
    try {
      ({ gitInitialized, generatedFiles } = await generateFullApp(cwd, projectName, templateName, { noTools: true }));

      if (provider !== 'later' && apiKey) {
        await writeProviderToConfig(studioDir, provider, apiKey, selectedModel);
      }

      spinner.stop();
    } catch (err) {
      spinner.fail('Failed');
      throw err;
    }

    // Step 9: Install selected tools
    if (selectedTools.length > 0) {
      await toolsAddDirect(studioDir, selectedTools);
    }

    // Step 10: Install dependencies (if requested)
    if (installNow) {
      const installSpinner = ora(`Running ${pkgManager} install...`).start();
      const installResult = spawnSync(pkgManager, ['install'], { cwd, encoding: 'utf-8' });
      if (installResult.status === 0) {
        installSpinner.succeed('Dependencies installed');
      } else {
        installSpinner.warn(`Install failed — run \`${pkgManager} install\` manually`);
        if (installResult.stderr) {
          console.error(installResult.stderr);
        }
      }
    }

    // Step 11: Success output
    console.log(chalk.green(`  ✓ .studio/config.yaml`));
    console.log(chalk.green(`  ✓ .studio/pipelines/`));
    for (const f of generatedFiles) {
      console.log(chalk.green(`  ✓ ${f}`));
    }
    if (gitInitialized) {
      console.log(chalk.green(`  ✓ git initialized`));
    }
    console.log(chalk.green(`  ✓ Updated .gitignore`));
    if (selectedTools.length > 0) {
      console.log(chalk.green(`  ✓ Installed tools: ${selectedTools.join(', ')}`));
    }
    console.log('');

    // Step 12: Next steps
    const firstPipeline = selectedTemplateMeta?.pipelines?.[0] ?? 'your-pipeline';

    console.log(chalk.bold('Done! Next steps:'));
    if (!installNow) {
      console.log(`  ${chalk.cyan(`${pkgManager} install`)}`);
    }
    console.log(
      `  ${chalk.cyan(`studio run ${firstPipeline} --input "..."`)}`
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
