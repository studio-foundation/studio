import { mkdir, access, cp } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import { input, select } from '@inquirer/prompts';
import { findStudioDir } from '../studio-dir.js';
import { listTemplates } from './templates.js';

const TEMPLATES_DIR = resolve(import.meta.dirname, '../../templates');

export const PROJECT_SUBDIRS = ['pipelines', 'agents', 'contracts', 'tools', 'inputs'];

/**
 * Create a project directory under .studio/projects/.
 * Throws if the project already exists or the template is not found.
 */
export async function createProjectDir(
  projectsDir: string,
  projectName: string,
  templateName?: string,
  options?: { withTools?: boolean }
): Promise<void> {
  const withTools = options?.withTools ?? true;
  const projectDir = join(projectsDir, projectName);

  // Check if already exists
  const alreadyExists = await access(projectDir).then(() => true).catch(() => false);
  if (alreadyExists) {
    throw new Error(`Project '${projectName}' already exists in ${projectsDir}`);
  }

  if (templateName) {
    const templateDir = resolve(TEMPLATES_DIR, 'projects', templateName);
    const templateExists = await access(templateDir).then(() => true).catch(() => false);
    if (!templateExists) {
      throw new Error(
        `Template '${templateName}' not found. Run 'studio templates list' to see available templates.`
      );
    }

    const templateProjectDir = join(templateDir, 'project');
    const hasProjectDir = await access(templateProjectDir).then(() => true).catch(() => false);

    if (hasProjectDir) {
      await mkdir(projectDir, { recursive: true });
      if (withTools) {
        await cp(templateProjectDir, projectDir, { recursive: true });
      } else {
        await cp(templateProjectDir, projectDir, {
          recursive: true,
          filter: (src) => {
            const rel = relative(templateProjectDir, src);
            return rel !== 'tools' && !rel.startsWith('tools' + sep);
          },
        });
        await mkdir(join(projectDir, 'tools'), { recursive: true });
      }
    } else {
      for (const sub of PROJECT_SUBDIRS) {
        await mkdir(join(projectDir, sub), { recursive: true });
      }
    }
  } else {
    for (const sub of PROJECT_SUBDIRS) {
      await mkdir(join(projectDir, sub), { recursive: true });
    }
  }
}

/**
 * Validate a project name: lowercase alphanumeric + hyphens, no leading/trailing hyphens.
 * Returns true if valid, or an error string if not.
 */
export function validateProjectName(name: string): true | string {
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return true;
  }
  return 'Project name must be lowercase alphanumeric with hyphens (e.g. my-project)';
}

/**
 * Non-interactive project creation.
 * Validates name, then delegates to createProjectDir.
 */
export async function projectAddDirect(
  studioDir: string,
  projectName: string,
  templateName?: string,
  _description?: string
): Promise<void> {
  const validation = validateProjectName(projectName);
  if (validation !== true) {
    throw new Error(validation);
  }
  const projectsDir = join(studioDir, 'projects');
  await createProjectDir(projectsDir, projectName, templateName);
}

/**
 * Interactive wizard for adding a project to an existing workspace.
 */
export async function projectAddWizard(studioDir: string): Promise<void> {
  // Step 1: Project name
  const rawName = await input({
    message: 'Project name:',
    validate: (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return 'Project name is required';
      const v = validateProjectName(trimmed);
      return v === true ? true : v;
    },
  });
  const projectName = rawName.trim();

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
    message: 'Choose a template:',
    choices: templateChoices,
  });

  // Step 4: Create
  console.log('');
  const spinner = ora('Creating project...').start();
  try {
    await projectAddDirect(studioDir, projectName, templateName);
    spinner.stop();
  } catch (err) {
    spinner.fail('Failed');
    throw err;
  }

  // Step 5: Success output
  const projectsDir = join(studioDir, 'projects');
  for (const sub of PROJECT_SUBDIRS) {
    console.log(chalk.green(`  ✓ ${join(projectsDir, projectName, sub).replace(process.cwd() + '/', '')}/`));
  }
  console.log('');

  // Step 6: Next steps
  const selectedTemplate = templates.find((t) => t.name === templateName);
  const firstPipeline = selectedTemplate?.pipelines?.[0] ?? 'your-pipeline';
  console.log(chalk.bold('Done! Run your first pipeline:'));
  console.log(`  ${chalk.cyan(`studio run ${projectName}/${firstPipeline} --input "..."`)}`);
  console.log('');
}

/**
 * CLI dispatcher for `studio project <action> [args...]`.
 */
export async function projectCommand(
  action: string,
  args: string[],
  options: { template?: string; description?: string }
): Promise<void> {
  try {
    if (action !== 'add') {
      console.error(`Unknown project action: ${action}. Available: add`);
      process.exit(1);
    }

    // Require existing .studio/
    const cwd = process.cwd();
    const studioDir = await findStudioDir(cwd);
    if (!studioDir) {
      console.error(chalk.red('Studio is not initialized in this directory.'));
      console.log(`Run: ${chalk.cyan('studio init')}`);
      process.exit(1);
    }

    const nameArg = args[0];

    if (nameArg) {
      // Direct mode
      const spinner = ora('Creating project...').start();
      try {
        await projectAddDirect(studioDir, nameArg, options.template, options.description);
        spinner.stop();
      } catch (err) {
        spinner.fail('Failed');
        throw err;
      }

      const projectsDir = join(studioDir, 'projects');
      for (const sub of PROJECT_SUBDIRS) {
        console.log(chalk.green(`  ✓ ${join(projectsDir, nameArg, sub).replace(cwd + '/', '')}/`));
      }
      console.log('');

      const templates = await listTemplates();
      const selectedTemplate = templates.find((t) => t.name === (options.template ?? 'blank'));
      const firstPipeline = selectedTemplate?.pipelines?.[0] ?? 'your-pipeline';
      console.log(chalk.bold('Done! Run your first pipeline:'));
      console.log(`  ${chalk.cyan(`studio run ${nameArg}/${firstPipeline} --input "..."`)}`);
      console.log('');
    } else {
      // Wizard mode
      console.log('');
      await projectAddWizard(studioDir);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'ExitPromptError') {
      console.log('\nAborted.');
      process.exit(0);
    }
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
