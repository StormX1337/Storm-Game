// One flat config for the whole STORM BET workspace. Type-aware linting stays
// off on purpose: `pnpm typecheck` runs tsc (strict, noUncheckedIndexedAccess)
// over every package, so lint only has to catch what the compiler accepts.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { next: { rootDir: 'apps/web' } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      '@next/next/no-html-link-for-pages': 'off',
    },
  },

  // Console output is the point of CLIs, seeds and build scripts.
  {
    files: [
      'apps/worker/src/seed.ts',
      'apps/worker/src/odds-check.ts',
      'scripts/**/*.{ts,mjs,js}',
      '**/*.config.{ts,mts,mjs,js}',
    ],
    rules: { 'no-console': 'off' },
  },

  {
    files: ['**/test/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', 'tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    // Tests assert on loosely typed JSON responses.
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
);
