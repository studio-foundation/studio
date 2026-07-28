import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { ContextPackDefinition, ResolvedContextPack } from '@studio-foundation/contracts';
import { resolveWithin } from './safe-path.js';

export async function loadContextPacks(
  packNames: string[],
  projectConfigPath: string,
  workspacePath?: string,
): Promise<ResolvedContextPack[]> {
  if (packNames.length === 0) return [];

  const packsDir = path.join(projectConfigPath, 'context-packs');
  const results: ResolvedContextPack[] = [];

  for (const packName of packNames) {
    const packFile = resolveWithin(packsDir, `${packName}.yaml`, 'Context pack');

    let rawContent: string;
    try {
      rawContent = await fs.readFile(packFile, 'utf-8');
    } catch {
      throw new Error(`Context pack "${packName}" not found at ${packFile}`);
    }

    const definition = yaml.load(rawContent) as ContextPackDefinition;
    const sections: Array<{ title: string; content: string }> = [];

    // File sections first (in YAML order)
    if (definition.files?.length) {
      if (!workspacePath) {
        throw new Error(
          `Context pack "${packName}" references files but workspace is not configured`,
        );
      }
      for (const fileRef of definition.files) {
        const filePath = resolveWithin(
          workspacePath,
          fileRef.path,
          `Context pack "${packName}" file`,
        );
        let content: string;
        try {
          content = await fs.readFile(filePath, 'utf-8');
        } catch {
          throw new Error(`File "${fileRef.path}" not found in workspace at ${filePath}`);
        }
        sections.push({ title: fileRef.path, content });
      }
    }

    // Inline sections after (in YAML order)
    if (definition.inline?.length) {
      for (const inline of definition.inline) {
        sections.push({ title: inline.title, content: inline.content });
      }
    }

    results.push({
      name: definition.name,
      ...(definition.description !== undefined && { description: definition.description }),
      sections,
    });
  }

  return results;
}
