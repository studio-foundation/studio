import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolveWithin } from './safe-path.js';

export interface SkillContent {
  name: string;
  content: string;
}

/**
 * Load `.skill.md` files by name from a skills directory.
 * Missing files are skipped with a warning (non-fatal); a name that escapes
 * `skillsDir` is a hard error.
 */
export async function loadSkillFiles(
  names: string[],
  skillsDir: string
): Promise<SkillContent[]> {
  if (names.length === 0) return [];

  // Resolve every name before the early return, so an escape attempt fails
  // whether or not the project happens to have a skills directory.
  const resolved = names.map((name) => ({
    name,
    filePath: resolveWithin(skillsDir, `${name}.skill.md`, 'Skill'),
  }));
  if (!existsSync(skillsDir)) return [];

  const results: SkillContent[] = [];
  for (const { name, filePath } of resolved) {
    try {
      const content = await readFile(filePath, 'utf-8');
      results.push({ name, content });
    } catch {
      console.warn(`[studio] Skill '${name}' not found at ${filePath} — skipping.`);
    }
  }
  return results;
}
