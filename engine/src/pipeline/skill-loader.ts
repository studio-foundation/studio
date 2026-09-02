import { readFile } from 'node:fs/promises';
import * as yaml from 'js-yaml';
import { resolveWithin } from './safe-path.js';

export interface SkillContent {
  name: string;
  description?: string;
  content: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Split a `.skill.md` into its frontmatter metadata and its body.
 * A file with no frontmatter is all body.
 */
function parseSkill(name: string, raw: string, filePath: string): SkillContent {
  const match = FRONTMATTER.exec(raw);
  if (!match) return { name, content: raw };

  let meta: unknown;
  try {
    meta = yaml.load(match[1]);
  } catch (err) {
    throw new Error(`Skill '${name}' has unparseable frontmatter at ${filePath}`, { cause: err });
  }

  const content = raw.slice(match[0].length);
  if (meta === null || typeof meta !== 'object') return { name, content };

  const { name: declared, description } = meta as { name?: unknown; description?: unknown };
  // The loaders resolve by filename, so a divergent `name` means the author believes
  // something false about which file is loading.
  if (typeof declared === 'string' && declared !== name) {
    throw new Error(
      `Skill '${name}' declares name '${declared}' in its frontmatter at ${filePath}. ` +
        `Skills are resolved by filename — rename the file or the field so they agree.`
    );
  }

  return {
    name,
    ...(typeof description === 'string' ? { description } : {}),
    content,
  };
}

/**
 * Load `.skill.md` files by name from a skills directory.
 * A declared skill that cannot be read is a hard error: an agent that answers
 * without the grounding it declared is indistinguishable from one that had it.
 * A name that escapes `skillsDir` is a hard error.
 */
export async function loadSkillFiles(
  names: string[],
  skillsDir: string
): Promise<SkillContent[]> {
  if (names.length === 0) return [];

  // Resolve every name up front, so an escape attempt fails whether or not the
  // project happens to have a skills directory.
  const resolved = names.map((name) => ({
    name,
    filePath: resolveWithin(skillsDir, `${name}.skill.md`, 'Skill'),
  }));

  const results: SkillContent[] = [];
  for (const { name, filePath } of resolved) {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch (err) {
      throw new Error(
        `Skill '${name}' could not be read at ${filePath}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`,
        { cause: err }
      );
    }
    results.push(parseSkill(name, raw, filePath));
  }
  return results;
}
