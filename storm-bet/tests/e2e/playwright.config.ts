import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the running stack (web :3000 → api :4000, with the
 * worker feeding simulated odds). Start it with `pnpm build && pnpm start`,
 * or let Playwright do so by setting E2E_START=1.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const start = process.env.E2E_START === '1';

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      grepInvert: /@mobile/,
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  ...(start
    ? {
        webServer: [
          {
            command: 'pnpm --filter @storm-bet/api start',
            url: 'http://localhost:4000/api/health',
            reuseExistingServer: true,
            cwd: '../..',
          },
          {
            command: 'pnpm --filter @storm-bet/worker start',
            port: 4100,
            reuseExistingServer: true,
            cwd: '../..',
          },
          {
            command: 'pnpm --filter @storm-bet/web start',
            url: baseURL,
            reuseExistingServer: true,
            cwd: '../..',
            timeout: 120_000,
          },
        ],
      }
    : {}),
});
