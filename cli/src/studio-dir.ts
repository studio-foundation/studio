import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Walk up the directory tree from `startDir` looking for a `.studio/` directory.
 * Like git looking for `.git/`.
 * Returns the absolute path to `.studio/`, or null if not found.
 */
export async function findStudioDir(startDir: string): Promise<string | null> {
  let current = resolve(startDir);

  while (true) {
    const candidate = join(current, '.studio');
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not found here, go up
    }

    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root
      return null;
    }
    current = parent;
  }
}
