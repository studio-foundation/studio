import semver from 'semver';
import { PACKAGE_VERSION } from './generated/bundled-assets.js';

/** The running Studio version — the single source is cli/package.json, inlined at build time. */
export const STUDIO_VERSION: string = PACKAGE_VERSION;

export const UPGRADE_HINT = '  Upgrade:  npm i -g @studio-foundation/cli@latest';

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

  return `${requiredBy} requires Studio ${required}, but you have ${current}.\n${UPGRADE_HINT}`;
}
