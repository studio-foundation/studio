import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface SkillContent {
  name: string;
  content: string;
}

/**
 * Load `.skill.md` files by name from a skills directory.
 * Missing files are skipped with a warning (non-fatal).
 */
export async function loadSkillFiles(
  names: string[],
  skillsDir: string
): Promise<SkillContent[]> {
  if (names.length === 0) return [];
  if (!existsSync(skillsDir)) return [];

  const results: SkillContent[] = [];
  for (const name of names) {
    const filePath = join(skillsDir, `${name}.skill.md`);
    try {
      const content = await readFile(filePath, 'utf-8');
      results.push({ name, content });
    } catch {
      console.warn(`[studio] Skill '${name}' not found at ${filePath} — skipping.`);
    }
  }
  return results;
}
