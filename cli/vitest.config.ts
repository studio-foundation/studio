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
  },
});
