import chalk from 'chalk';
import { RegistryCache } from '../registry/cache.js';
import { syncRegistry } from './registry/sync.js';
import { BUNDLED_ASSETS } from '../generated/bundled-assets.js';

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
  // 1. Load local (bundled) templates
  const localTemplates: TemplateMetadata[] = [];
  for (const key of Object.keys(BUNDLED_ASSETS).sort()) {
    if (!key.startsWith('projects/') || !key.endsWith('/metadata.json')) continue;
    try {
      localTemplates.push(JSON.parse(BUNDLED_ASSETS[key]) as TemplateMetadata);
    } catch {
      // Skip malformed metadata
    }
  }

  // 2. Merge with registry templates (sync silently if stale, fall back gracefully)
  const registryTemplates: TemplateMetadata[] = [];
  try {
    await syncRegistry({ force: false, silent: true });
    const cache = new RegistryCache();
    const index = await cache.read();
    if (index) {
      const localNames = new Set(localTemplates.map((t) => t.name));
      for (const pkg of index.packages) {
        if (pkg.type === 'template' && !localNames.has(pkg.name)) {
          registryTemplates.push({
            name: pkg.name,
            version: pkg.version,
            description: pkg.description,
            author: pkg.author,
            tags: pkg.tags,
            studio_version: pkg.studio_version ?? undefined,
          });
        }
      }
    }
  } catch {
    // Registry unreachable — show local templates only
  }

  return [...localTemplates, ...registryTemplates];
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
