import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import chalk from 'chalk';
import { findStudioDir } from '../studio-dir.js';

const TEMPLATES_DIR = resolve(import.meta.dirname, '../../templates');

const GITIGNORE_ENTRIES = ['.studio/config.yaml', '.studio/runs/'];

const PROJECT_SUBDIRS = ['pipelines', 'agents', 'contracts', 'tools', 'inputs'];

/**
 * Create the full .studio/ directory structure in `cwd`.
 * Throws if .studio/ already exists anywhere in the directory tree.
 */
export async function createStudioStructure(
  cwd: string,
  projectName = 'default'
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

  // Create project subdirectories
  for (const sub of PROJECT_SUBDIRS) {
    await mkdir(join(projectDir, sub), { recursive: true });
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

interface InitOptions {
  template?: string;
}

export async function initCommand(options: InitOptions = {}): Promise<void> {
  try {
    const cwd = process.cwd();
    const projectName = options.template ?? 'default';

    console.log(chalk.blue('\nInitializing Studio project...\n'));

    await createStudioStructure(cwd, projectName);

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
