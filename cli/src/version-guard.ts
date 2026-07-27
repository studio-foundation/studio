import semver from 'semver';
import { PACKAGE_VERSION } from './generated/bundled-assets.js';
import { detectInstall } from './upgrade.js';
import type { Install } from './upgrade.js';

/** The running Studio version — the single source is cli/package.json, inlined at build time. */
export const STUDIO_VERSION: string = PACKAGE_VERSION;

/** The update command for the channel this install came from — the two are not interchangeable. */
export function upgradeHint(install: Install = detectInstall()): string {
  return install.kind === 'binary'
    ? '  Upgrade:  studio upgrade'
    : '  Upgrade:  npm i -g @studio-foundation/cli@latest';
}

/**
 * Compare a declared `studio_version` range against the running version.
 *
 * Returns null when compatible (or when nothing is declared), otherwise an
 * unprefixed message — callers wrap it as an error or throw it. `requiredBy`
 * names the declarer and opens the sentence: "This project", "Package 'foo'".
 */
export function checkStudioVersion(
  required: string | null | undefined,
  requiredBy: string,
  current: string = STUDIO_VERSION
): string | null {
  if (!required) return null;

  if (!semver.validRange(required)) {
    return `${requiredBy} declares an invalid studio_version range: '${required}'.`;
  }

  if (semver.satisfies(current, required, { includePrerelease: true })) return null;

  return `${requiredBy} requires Studio ${required}, but you have ${current}.\n${upgradeHint()}`;
}
