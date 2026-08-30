import { expect, test as setup } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_STATE } from './fixtures';

/**
 * Signs in once and saves the session for every test that needs an
 * administrator. Signing in per test would work, but the panel rate-limits
 * authentication deliberately — and a suite that cannot be run twice in five
 * minutes is a suite people stop running.
 */
setup('authenticate as the administrator', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email or username').fill(ADMIN_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.waitForURL('**/dashboard', { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();

  await page.context().storageState({ path: ADMIN_STATE });
});
