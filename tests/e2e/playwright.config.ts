import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests drive the real panel in a browser against a running stack.
 *
 *   pnpm dev            # or docker compose up -d
 *   pnpm test:e2e
 *
 * Set STORM_BASE_URL to point at a different deployment.
 */
const baseURL = process.env.STORM_BASE_URL ?? 'http://localhost:3000';
const adminState = path.join(__dirname, '.auth', 'admin.json');

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.ts', '**/*.setup.ts'],
  // Registration and server creation are inherently sequential against one
  // database; running them in parallel would fight over ports and limits.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    ...devices['Desktop Chrome'],
    launchOptions: {
      // Chromium ships preinstalled in the container image used for CI.
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
        : {}),
      args: ['--no-sandbox'],
    },
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts$/ },
    {
      name: 'chromium',
      testMatch: /.*\.spec\.ts$/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: adminState },
    },
  ],
});
