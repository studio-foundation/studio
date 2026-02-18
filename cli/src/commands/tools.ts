import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadConfig } from '../config.js';

const TOOL_TEMPLATES_DIR = resolve(import.meta.dirname, '../../templates/tools');

export function getToolsDir(studioDir: string, project: string): string {
  return resolve(studioDir, 'projects', project, 'tools');
}

export async function listTools(toolsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(toolsDir);
    return entries
      .filter((f) => f.endsWith('.tool.yaml'))
      .map((f) => f.replace('.tool.yaml', ''))
      .sort();
  } catch {
    return [];
  }
}

async function resolveProjectToolsDir(
  projectName?: string
): Promise<{ toolsDir: string; project: string }> {
  const config = await loadConfig();
  const studioDir = config.resolvedStudioDir;

  if (!studioDir) {
    console.error("Error: No .studio/ directory found. Run 'studio init' first.");
    process.exit(1);
  }

  // Discover project name if not provided
  let project = projectName;
  if (!project) {
    const projectsDir = resolve(studioDir, 'projects');
    try {
      const entries = await readdir(projectsDir, { withFileTypes: true });
      const projects = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      if (projects.length === 1) {
        project = projects[0]!;
      } else if (projects.length === 0) {
        console.error('Error: No projects found in .studio/projects/. Create one first.');
        process.exit(1);
      } else {
        console.error(
          `Error: Multiple projects found. Specify one with --project <name>: ${projects.join(', ')}`
        );
        process.exit(1);
      }
    } catch {
      console.error('Error: Cannot read .studio/projects/');
      process.exit(1);
    }
  }

  return { toolsDir: getToolsDir(studioDir, project!), project: project! };
}

interface ToolsOptions {
  project?: string;
}

export async function toolsCommand(
  action: string,
  args: string[],
  options: ToolsOptions
): Promise<void> {
  try {
    switch (action) {
      case 'list': {
        const { toolsDir, project } = await resolveProjectToolsDir(options.project);
        const tools = await listTools(toolsDir);

        if (tools.length === 0) {
          console.log(chalk.yellow(`No tools installed for project '${project}'`));
          console.log(`  Run: studio tools add <name> --project ${project}`);
        } else {
          console.log(`\nInstalled tools (${project}):`);
          for (const t of tools) {
            console.log(`  - ${t}`);
          }
          console.log('');
        }
        break;
      }

      case 'add': {
        const name = args[0];
        if (!name) {
          console.error('Usage: studio tools add <name> --project <project>');
          process.exit(1);
        }
        const { toolsDir, project } = await resolveProjectToolsDir(options.project);
        await mkdir(toolsDir, { recursive: true });

        const templatePath = resolve(TOOL_TEMPLATES_DIR, `${name}.tool.yaml`);
        let templateContent: string;
        try {
          templateContent = await readFile(templatePath, 'utf-8');
        } catch {
          console.error(
            `Error: Unknown tool '${name}'. Available: repo-manager, shell, search`
          );
          process.exit(1);
        }

        const destPath = resolve(toolsDir, `${name}.tool.yaml`);
        await writeFile(destPath, templateContent, 'utf-8');
        console.log(chalk.green(`✓ Added tool '${name}' to project '${project}'`));
        break;
      }

      case 'remove': {
        const name = args[0];
        if (!name) {
          console.error('Usage: studio tools remove <name> --project <project>');
          process.exit(1);
        }
        const { toolsDir, project } = await resolveProjectToolsDir(options.project);
        const toolPath = resolve(toolsDir, `${name}.tool.yaml`);
        try {
          await unlink(toolPath);
          console.log(chalk.green(`✓ Removed tool '${name}' from project '${project}'`));
        } catch {
          console.error(`Error: Tool '${name}' not found in project '${project}'`);
          process.exit(1);
        }
        break;
      }

      case 'info': {
        const name = args[0];
        if (!name) {
          console.error('Usage: studio tools info <name> --project <project>');
          process.exit(1);
        }
        const { toolsDir } = await resolveProjectToolsDir(options.project);
        const toolPath = resolve(toolsDir, `${name}.tool.yaml`);
        try {
          const content = await readFile(toolPath, 'utf-8');
          console.log(content);
        } catch {
          console.error(`Error: Tool '${name}' not found.`);
          process.exit(1);
        }
        break;
      }

      default:
        console.error(
          `Unknown tools action: ${action}. Available: list, add, remove, info`
        );
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
