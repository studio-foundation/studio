import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillContent } from '../../plugins/plugin-loader.js';

export type { SkillContent };

/** Minimal structure required for a valid skill manifest */
export interface SkillManifest {
  name: string;
  content: string;
}

/**
 * Load multiple `.skill.md` files by name from `.studio/skills/`.
 * Missing files are skipped with a warning (non-fatal).
 */
export async function loadSkills(skillNames: string[], studioDir: string): Promise<SkillContent[]> {
  const results: SkillContent[] = [];
  for (const name of skillNames) {
    const skill = await loadSkill(name, studioDir);
    if (skill) results.push(skill);
  }
  return results;
}

/**
 * Load a single `.skill.md` file by name from `<studioDir>/skills/`.
 * Returns null if the file does not exist.
 */
export async function loadSkill(name: string, studioDir: string): Promise<SkillContent | null> {
  const filePath = join(studioDir, 'skills', `${name}.skill.md`);
  if (!existsSync(filePath)) {
    console.warn(`[studio] Skill '${name}' not found at ${filePath} — skipping.`);
    return null;
  }
  try {
    const content = await readFile(filePath, 'utf-8');
    return { name, content };
  } catch {
    console.warn(`[studio] Failed to load skill '${name}' — skipping.`);
    return null;
  }
}

/**
 * Validate that a skill manifest has the required structure.
 * Throws a descriptive error if invalid.
 */
export function validateSkillManifest(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Skill manifest must be an object');
  }
  const m = manifest as Record<string, unknown>;
  if (typeof m.name !== 'string') {
    throw new Error('Skill manifest must have a string "name" field');
  }
  if (typeof m.content !== 'string') {
    throw new Error('Skill manifest must have a string "content" field');
  }
  return true;
}
