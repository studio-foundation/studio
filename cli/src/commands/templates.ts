import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import chalk from 'chalk';

const PROJECTS_TEMPLATES_DIR = resolve(import.meta.dirname, '../../templates/projects');

export interface TemplateMetadata {
  name: string;
  version: string;
  description: string;
  author?: string;
  tags?: string[];
  type?: string;
  studio_version?: string;
  pipelines?: string[];
  tools_included?: string[];
}

export async function listTemplates(): Promise<TemplateMetadata[]> {
  try {
    const entries = await readdir(PROJECTS_TEMPLATES_DIR, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    const templates: TemplateMetadata[] = [];
    for (const dir of dirs) {
      try {
        const metaPath = join(PROJECTS_TEMPLATES_DIR, dir, 'metadata.json');
        const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as TemplateMetadata;
        templates.push(meta);
      } catch {
        // Skip malformed or missing metadata
      }
    }
    return templates;
  } catch {
    return [];
  }
}

export async function templatesCommand(action: string, _args: string[]): Promise<void> {
  try {
    switch (action) {
      case 'list': {
        const templates = await listTemplates();
        if (templates.length === 0) {
          console.log(chalk.yellow('No templates available.'));
          return;
        }
        console.log('\nAvailable templates:\n');
        const maxLen = Math.max(...templates.map((t) => t.name.length));
        for (const t of templates) {
          console.log(`  ${t.name.padEnd(maxLen + 2)}${chalk.gray(t.description)}`);
        }
        console.log('');
        console.log(`Run: ${chalk.cyan('studio init --template <name>')}`);
        console.log('');
        break;
      }
      default:
        console.error(`Unknown templates action: ${action}. Available: list`);
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
