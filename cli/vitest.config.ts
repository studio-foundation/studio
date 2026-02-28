import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // @studio/runner is a workspace package that may not be built in all environments.
      // Point to a stub so tests can run without requiring a dist/ build.
      '@studio/runner': resolve(import.meta.dirname, 'tests/__stubs__/studio-runner.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
