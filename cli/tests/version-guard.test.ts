import { describe, it, expect } from 'vitest';
import { checkStudioVersion, STUDIO_VERSION } from '../src/version-guard.js';

describe('checkStudioVersion', () => {
  it('passes when nothing is declared', () => {
    expect(checkStudioVersion(undefined, 'This project', '0.9.0')).toBeNull();
    expect(checkStudioVersion(null, 'This project', '0.9.0')).toBeNull();
    expect(checkStudioVersion('', 'This project', '0.9.0')).toBeNull();
  });

  it('passes when the current version satisfies the range', () => {
    expect(checkStudioVersion('>=0.10.0', 'This project', '0.10.0')).toBeNull();
    expect(checkStudioVersion('>=0.10.0', 'This project', '0.11.3')).toBeNull();
    expect(checkStudioVersion('^0.10.0', 'This project', '0.10.4')).toBeNull();
    expect(checkStudioVersion('0.10.x', 'This project', '0.10.9')).toBeNull();
  });

  it('reports the range, the installed version and the upgrade command', () => {
    expect(checkStudioVersion('>=0.10.0', 'This project', '0.9.0')).toBe(
      'This project requires Studio >=0.10.0, but you have 0.9.0.\n' +
        '  Upgrade:  npm i -g @studio-foundation/cli@latest'
    );
  });

  it('names the declarer for a registry package', () => {
    expect(checkStudioVersion('>=0.11.0', "Package 'wiki-tools'", '0.10.0')).toContain(
      "Package 'wiki-tools' requires Studio >=0.11.0, but you have 0.10.0."
    );
  });

  it('rejects a range that is not valid semver', () => {
    expect(checkStudioVersion('latest', 'This project', '0.10.0')).toBe(
      "This project declares an invalid studio_version range: 'latest'."
    );
  });

  it('satisfies a range from a prerelease build', () => {
    expect(checkStudioVersion('>=0.10.0', 'This project', '0.11.0-rc.1')).toBeNull();
  });

  it('defaults to the version shipped in cli/package.json', () => {
    expect(STUDIO_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(checkStudioVersion(`>=${STUDIO_VERSION}`, 'This project')).toBeNull();
  });
});
