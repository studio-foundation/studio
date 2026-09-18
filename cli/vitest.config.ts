import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// Use a stub only when @studio/runner has not been built (e.g. a fresh git worktree).
// When dist/ exists (CI, main checkout) the real package is used so that transitive
// imports from other packages (e.g. @studio/api) continue to resolve correctly.
const runnerDist = resolve(import.meta.dirname, '../runner/dist/index.js');
const runnerAlias = existsSync(runnerDist) ? {} : {
  '@studio-foundation/runner': resolve(import.meta.dirname, 'tests/__stubs__/studio-runner.ts'),
};

export default defineConfig({
  resolve: {
    alias: runnerAlias,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // vitest's 5000ms default is tight for a test whose first line is a cold
    // `await import(...)` of the CLI's module graph — on a machine also running
    // a build, that alone measured 5039-5083ms (STU-1243). 15s gives headroom
    // for a loaded machine without hiding a genuinely hung test for that long.
    testTimeout: 15000,
  },
});
