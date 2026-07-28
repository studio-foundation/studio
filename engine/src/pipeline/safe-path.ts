import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Resolve `segment` under `baseDir`, refusing anything that leaves it (INV-09).
 *
 * `label` names the offending config value in the error — it is the only thing
 * the config author sees, so it must identify what to fix.
 */
export function resolveWithin(baseDir: string, segment: string, label: string): string {
  const base = resolve(baseDir);
  const target = resolve(base, segment);
  const rel = relative(base, target);

  if (isAbsolute(segment) || segment.startsWith('~') || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(
      `${label} "${segment}" escapes ${base} — absolute paths, "~" and ".." are refused (INV-09).`,
    );
  }

  return target;
}
