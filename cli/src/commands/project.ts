import { mkdir, access, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const TEMPLATES_DIR = resolve(import.meta.dirname, '../../templates');

export const PROJECT_SUBDIRS = ['pipelines', 'agents', 'contracts', 'tools', 'inputs'];

/**
 * Create a project directory under .studio/projects/.
 * Throws if the project already exists or the template is not found.
 */
export async function createProjectDir(
  projectsDir: string,
  projectName: string,
  templateName?: string
): Promise<void> {
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
      await cp(templateProjectDir, projectDir, { recursive: true });
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
