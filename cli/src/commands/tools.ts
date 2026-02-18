import { readdir, readFile, writeFile, unlink, mkdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { load } from 'js-yaml';
import { select, checkbox } from '@inquirer/prompts';
import { loadConfig } from '../config.js';

const TOOL_TEMPLATES_DIR = resolve(import.meta.dirname, '../../templates/tools');

export function getToolsDir(studioDir: string, project: string): string {
  return resolve(studioDir, 'projects', project, 'tools');
}

export async function listAvailableTools(): Promise<{ name: string; description: string }[]> {
  const entries = await readdir(TOOL_TEMPLATES_DIR);
  const yamlFiles = entries.filter((f) => f.endsWith('.tool.yaml')).sort();
  const tools: { name: string; description: string }[] = [];
  for (const file of yamlFiles) {
    const content = await readFile(resolve(TOOL_TEMPLATES_DIR, file), 'utf-8');
    const parsed = load(content) as { name?: string; description?: string };
    const toolName = file.replace('.tool.yaml', '');
    tools.push({
      name: toolName,
      description: parsed.description ?? '',
    });
  }
  return tools;
}

export async function toolsAddDirect(
  studioDir: string,
  project: string,
  toolNames: string[]
): Promise<{ installed: string[]; skipped: string[] }> {
  const toolsDir = getToolsDir(studioDir, project);
  await mkdir(toolsDir, { recursive: true });

  const installed: string[] = [];
  const skipped: string[] = [];

  for (const name of toolNames) {
    const templatePath = resolve(TOOL_TEMPLATES_DIR, `${name}.tool.yaml`);
    let templateContent: string;
    try {
      templateContent = await readFile(templatePath, 'utf-8');
    } catch {
      const available = await listAvailableTools();
      throw new Error(`Unknown tool '${name}'. Available: ${available.map((t) => t.name).join(', ')}`);
    }

    const destPath = resolve(toolsDir, `${name}.tool.yaml`);
    const alreadyInstalled = await access(destPath).then(() => true).catch(() => false);
    if (alreadyInstalled) {
      skipped.push(name);
      continue;
    }

    await writeFile(destPath, templateContent, 'utf-8');
    installed.push(name);
  }

  return { installed, skipped };
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
        if (args.length === 0) {
          // Wizard mode
          const config = await loadConfig();
          const studioDir = config.resolvedStudioDir;
          if (!studioDir) {
            console.error("Error: No .studio/ directory found. Run 'studio init' first.");
            process.exit(1);
          }

          // Discover projects
          const projectsDir = resolve(studioDir, 'projects');
          let projectEntries: string[];
          try {
            const entries = await readdir(projectsDir, { withFileTypes: true });
            projectEntries = entries.filter((e) => e.isDirectory()).map((e) => e.name);
          } catch {
            projectEntries = [];
          }

          if (projectEntries.length === 0) {
            console.error(chalk.red("No projects found. Run 'studio project add' first."));
            process.exit(1);
          }

          // Select project
          let selectedProject: string;
          if (options.project) {
            selectedProject = options.project;
          } else if (projectEntries.length === 1) {
            selectedProject = projectEntries[0]!;
          } else {
            selectedProject = await select({
              message: 'Which project?',
              choices: projectEntries.map((p) => ({ value: p, name: p })),
            });
          }

          // Select tools via checkbox
          console.log('');
          const available = await listAvailableTools();
          const alreadyInstalled = await listTools(getToolsDir(studioDir, selectedProject));

          const choices = available.map((t) => ({
            value: t.name,
            name: `${t.name} — ${t.description}`,
            disabled: alreadyInstalled.includes(t.name) ? '(already installed)' : false,
          }));

          const selected: string[] = await checkbox({
            message: 'Select tools to install:',
            choices,
          });

          if (selected.length === 0) {
            console.log('No tools selected.');
            break;
          }

          // Install
          console.log('\nInstalling tools...');
          const { installed, skipped } = await toolsAddDirect(studioDir, selectedProject, selected);

          for (const name of installed) {
            console.log(chalk.green(`  ✓ ${name}.tool.yaml`));
          }
          for (const name of skipped) {
            console.log(chalk.yellow(`  ⚠ ${name} already installed, skipping`));
          }
          console.log('');
          console.log(`Done! ${installed.length} tool${installed.length !== 1 ? 's' : ''} installed in '${selectedProject}'.`);
          break;
        }

        // Direct mode
        const { project } = await resolveProjectToolsDir(options.project);
        const config = await loadConfig();
        const studioDir = config.resolvedStudioDir!;

        const { installed, skipped } = await toolsAddDirect(studioDir, project, args);

        for (const name of installed) {
          console.log(chalk.green(`  ✓ ${name}.tool.yaml`));
        }
        for (const name of skipped) {
          console.log(chalk.yellow(`  ⚠ ${name} already installed, skipping`));
        }
        console.log('');
        if (installed.length > 0) {
          console.log(`Done! ${installed.length} tool${installed.length > 1 ? 's' : ''} installed in '${project}'.`);
        } else {
          console.log('No new tools installed.');
        }
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
