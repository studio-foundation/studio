import { readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';

// A keymap is a plaintext token → PII table that only matters while its run's output is being restored.
export const KEYMAP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const KEYMAP_SUFFIX = '.keymap.json';

export function keymapDir(configsDir: string): string {
  return join(configsDir, 'runs', 'anonymization');
}

/** Remove every keymap in `dir` for which `shouldRemove(runId, mtimeMs)` is true; returns the run ids removed. */
export async function purgeKeymaps(
  dir: string,
  shouldRemove: (runId: string, mtimeMs: number) => boolean,
  dryRun = false,
): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.endsWith(KEYMAP_SUFFIX)) continue;
    const file = join(dir, name);
    const runId = name.slice(0, -KEYMAP_SUFFIX.length);
    if (shouldRemove(runId, (await stat(file)).mtimeMs)) {
      if (!dryRun) await rm(file, { force: true });
      removed.push(runId);
    }
  }
  return removed;
}
