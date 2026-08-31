// One flat config for the whole workspace. Type-aware linting is deliberately
// off: `pnpm typecheck` already runs tsc over every project with strict and
// noUncheckedIndexedAccess, so repeating it here would only make lint slow.
// What is left is the class of mistake the compiler accepts and a reviewer
// would not.
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
      'packages/database/generated/**',
      'apps/web/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      // The codebase uses `_` prefixes for intentionally unused bindings —
      // caught parameters and destructured rest siblings especially.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // `any` shows up where third-party types are wrong or absent; the
      // compiler still refuses to let it spread silently under strict mode.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },

  // Frontend: browser globals, plus the two rule sets that catch the React
  // and Next mistakes which typecheck cannot see.
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      // App Router only — there is no pages/ directory for this rule to read,
      // and it prints a warning on every run looking for one.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },

  // Console output is the point in the CLI, the installers and the scripts.
  {
    files: [
      'apps/api/src/cli/**/*.ts',

      'packages/database/src/seed/**/*.ts',
      'scripts/**/*.{ts,mjs,js}',
      '**/*.config.{ts,mts,mjs,js}',
    ],
    rules: { 'no-console': 'off' },
  },

  // Game template install scripts are shell inside template literals. `\${VAR}`
  // has to be escaped or JS eats it; `\$VAR` does not, but escaping every shell
  // variable the same way is what keeps them readable and hard to get wrong.
  {
    files: ['packages/database/src/seed/templates.ts'],
    rules: { 'no-useless-escape': 'off' },
  },

  // Tests assert against loose shapes and reach for globals of their own.
  {
    files: ['**/test/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', 'tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
);
