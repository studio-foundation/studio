import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// INV-10: the package dependency graph is a strict DAG. Each entry lists the
// internal packages that one may import — anything else is an upward or lateral
// import and fails the lint.
const ALLOWED_INTERNAL_IMPORTS = {
  contracts: [],
  anonymizer: [],
  ralph: ['contracts'],
  runner: ['contracts', 'anonymizer'],
  engine: ['contracts', 'ralph', 'runner'],
  api: ['contracts', 'engine', 'runner'],
  cli: ['contracts', 'engine', 'runner', 'api'],
};

const dagConfigs = Object.entries(ALLOWED_INTERNAL_IMPORTS).map(([pkg, allowed]) => ({
  files: [`${pkg}/**/*.ts`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: [
              '@studio-foundation/*',
              ...allowed.map((dep) => `!@studio-foundation/${dep}`),
              ...allowed.map((dep) => `!@studio-foundation/${dep}/*`),
            ],
            message: `INV-10: ${pkg} may only import ${
              allowed.length ? allowed.join(', ') : 'no internal package'
            }.`,
          },
        ],
      },
    ],
  },
}));

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/templates/**',
      '**/.worktrees/**',
      '**/.studio/**',
      'research/**',
    ],
  },

  js.configs.recommended,

  {
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Baseline: 226 pre-existing `any` across the monorepo. Warn, with
      // `--max-warnings 226` in the lint script as a ratchet — the count may
      // only go down. Flip to 'error' once it reaches zero.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // Type-aware rules only where a package tsconfig covers the files. Every
  // package tsconfig excludes tests/, so tests keep the syntactic rules above.
  {
    files: ['*/src/**/*.ts'],
    ignores: ['*/src/**/*.test.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },

  ...dagConfigs,

  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },
);
