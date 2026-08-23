import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { PLATFORMS } from '../../scripts/platforms.mjs';

const WORKFLOW = fileURLToPath(
  new URL('../../.github/workflows/build-binaries.yml', import.meta.url)
);

describe('the build matrix', () => {
  it('compiles every platform the npm packaging expects', () => {
    // build-npm-packages.mjs copies one binary per PLATFORMS key and dies on ENOENT,
    // so a platform added here and not to the matrix fails at publish time — after
    // the version bump has already merged.
    const compiled = new Set(
      readFileSync(WORKFLOW, 'utf-8')
        .split('\n')
        .filter(line => line.trim().startsWith('platforms:'))
        .flatMap(line => line.split(':')[1].trim().split(/\s+/))
    );

    expect(Object.keys(PLATFORMS).filter(key => !compiled.has(key))).toEqual([]);
  });
});
