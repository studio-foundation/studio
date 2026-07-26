import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**'],
    // Most of this package is erased at compile time, so the *.test-d.ts
    // assertions are the only ones that can cover it.
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      // The runtime surface is small enough that anything less than full
      // coverage means a shipped function nobody executed. See README.
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
