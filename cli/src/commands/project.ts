import { mkdir, access, cp } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import chalk from 'chalk';
import { input, select } from '@inquirer/prompts';
import { listTemplates } from './templates.js';

const TEMPLATES_DIR = resolve(import.meta.dirname, '../../templates');

export const PROJECT_SUBDIRS = ['pipelines', 'agents', 'contracts', 'tools', 'inputs'];

/**
 * Create a project directory under .studio/projects/.
 * Throws if the project already exists or the template is not found.
 *
 * @deprecated The flat .studio/ structure no longer uses projects/ subdirs.
 * This function is kept for backward compatibility but will be removed.
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

    await mkdir(projectDir, { recursive: true });
    if (withTools) {
      await cp(templateDir, projectDir, {
        recursive: true,
        filter: (src) => !src.endsWith('metadata.json'),
      });
    } else {
      await cp(templateDir, projectDir, {
        recursive: true,
        filter: (src) => {
          const rel = relative(templateDir, src);
          return !rel.endsWith('metadata.json') && rel !== 'tools' && !rel.startsWith('tools' + sep);
        },
      });
      await mkdir(join(projectDir, 'tools'), { recursive: true });
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
 *
 * @deprecated Use studio init in a new directory instead.
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
 *
 * @deprecated Use studio init in a new directory instead.
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
  const projectsDir = join(studioDir, 'projects');
  await projectAddDirect(studioDir, projectName, templateName);

  // Step 5: Success output
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
 * This command is deprecated — the flat .studio/ structure no longer uses projects/ subdirs.
 */
export async function projectCommand(
  _action: string,
  _args: string[],
  _options: { template?: string; description?: string }
): Promise<void> {
  console.error(
    chalk.red('  ✗ `studio project add` is no longer supported.')
  );
  console.log('');
  console.log('Each workspace now has one flat .studio/ structure.');
  console.log(`To start a new project, create a new directory and run ${chalk.cyan('studio init')}.`);
  console.log('');
  process.exit(1);
}
