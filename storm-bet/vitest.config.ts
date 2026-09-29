import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/unit/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.int.test.ts', 'apps/*/test/**/*.int.test.ts'],
          environment: 'node',
          globalSetup: ['./tests/integration/global-setup.ts'],
          setupFiles: ['./tests/integration/env.ts'],
          // Integration suites share one database; they create their own rows
          // and never truncate (the ledger is append-only by trigger).
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
