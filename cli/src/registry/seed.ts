import { BUNDLED_ASSETS } from '../generated/bundled-assets.js';
import type { RegistryIndex } from './types.js';

/**
 * The pre-fetched marketplace snapshot bundled with the CLI, used when the live
 * registry is unreachable. It mirrors the marketplace layout verbatim, so every
 * lookup is a path lookup — the kernel never names a package. Refresh it with
 * `node scripts/refresh-seed.mjs`.
 */
const SEED_PREFIX = 'seed/';

export function seedIndex(): RegistryIndex | null {
  const raw = BUNDLED_ASSETS[`${SEED_PREFIX}index.json`];
  return raw ? (JSON.parse(raw) as RegistryIndex) : null;
}

/** The seeded copy of one marketplace file, addressed as the registry addresses it. */
export function seedFile(path: string): string | null {
  return BUNDLED_ASSETS[`${SEED_PREFIX}${path}`] ?? null;
}

/** Every seeded file under `dir`, with paths relative to `dir`, sorted. */
export function seedFiles(dir: string): Array<{ path: string; content: string }> {
  const prefix = `${SEED_PREFIX}${dir}/`;
  return Object.keys(BUNDLED_ASSETS)
    .filter((key) => key.startsWith(prefix))
    .sort()
    .map((key) => ({ path: key.slice(prefix.length), content: BUNDLED_ASSETS[key] }));
}
