import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Load `.studio/invariants.md` from the project directory.
 * Returns content if the file exists, undefined otherwise (non-fatal).
 */
export async function loadInvariantsFile(projectDir: string): Promise<string | undefined> {
  try {
    return await readFile(join(projectDir, 'invariants.md'), 'utf-8');
  } catch {
    return undefined;
  }
}
