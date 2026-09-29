import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  login,
  openUpcomingEvent,
  placeFirstOpenSelection,
  register,
} from './helpers';

const uniqueEmail = () => `e2e-${randomUUID().slice(0, 8)}@test.local`;
const PASSWORD = 'E2e-Passwort-2026';

test.describe('player journey', () => {
  test('register, log in, place a demo bet and find it in the history', async ({ page }) => {
    const email = uniqueEmail();

    // Registration
    await register(page, email, PASSWORD);
    await expect(page.getByRole('heading', { name: /Willkommen/ })).toBeVisible();
    await expect(page.getByTestId('dashboard-cards')).toContainText('1.000,00');

    // Logout and login
    await page.getByTestId('user-menu').click();
    await page.getByTestId('logout').click();
    await expect(page.getByRole('link', { name: 'Anmelden', exact: true })).toBeVisible();
    await login(page, email, PASSWORD);

    // Event → selection → bet slip → demo bet
    await openUpcomingEvent(page);
    await placeFirstOpenSelection(page, '5');
    const reference = (
      await page.getByTestId('bet-receipt').locator('.font-mono').first().textContent()
    )?.trim();
    expect(reference).toMatch(/^SB-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await expect(page.getByTestId('header-balance')).toContainText('995,00');

    // Bet history
    await page.goto('/dashboard/bets');
    await expect(page.getByTestId('bet-card').first()).toContainText(reference!);
    await page.getByRole('link', { name: 'Offen', exact: true }).click();
    await expect(page.getByTestId('bet-card').first()).toContainText('Offen');
    await page.getByTestId('bet-card').first().click();
    await expect(page.getByText('Auswahlen & Quoten-Snapshot')).toBeVisible();
  });

  test('the bet slip shows combined odds and the potential return', async ({ page }) => {
    await page.goto('/sports/football');
    const rows = page
      .getByTestId('event-row')
      .filter({ hasNot: page.getByText('Live', { exact: true }) });
    await rows.nth(0).locator('[data-testid=odds-button]:not([disabled])').first().click();
    await rows.nth(1).locator('[data-testid=odds-button]:not([disabled])').first().click();
    await expect(page.getByTestId('slip-item')).toHaveCount(2);
    await page.getByTestId('stake-input').fill('10');
    await page.waitForTimeout(600);
    const total = Number((await page.getByTestId('total-odds').textContent())!.trim());
    expect(total).toBeGreaterThan(1);
    const shown = Number(
      (await page.getByTestId('potential-return').textContent())!
        .replace(/[^\d,]/g, '')
        .replace(',', '.'),
    );
    expect(Math.abs(shown - Math.floor(10 * total * 100) / 100)).toBeLessThan(0.02);
    await expect(page.getByRole('link', { name: 'Anmelden, um zu wetten' })).toBeVisible();
  });

  test('protected pages redirect to the login', async ({ page }) => {
    await page.goto('/dashboard/bets');
    await expect(page).toHaveURL(/\/login\?next=/);
  });
});

test.describe('platform', () => {
  test('pages carry a nonce CSP and security headers; the demo notice is visible', async ({
    page,
  }) => {
    const response = await page.goto('/');
    const headers = response!.headers();
    expect(headers['content-security-policy']).toMatch(
      /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/,
    );
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    await expect(page.getByText('Demo-Modus:')).toBeVisible();
  });

  test('staff see the admin area, players do not', async ({ page, browser }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: 'Übersicht' })).toBeVisible();
    await page.getByRole('link', { name: 'Audit-Log' }).click();
    await expect(page.getByRole('heading', { name: 'Audit-Log' })).toBeVisible();

    const player = await browser.newPage();
    await register(player, uniqueEmail(), PASSWORD, 'Kein Admin');
    const res = await player.goto('/admin');
    expect(res!.status()).toBe(404);
    await player.close();
  });
});

test('mobile: no horizontal overflow and the sticky slip opens @mobile', async ({ page }) => {
  await page.goto('/sports/tennis');
  const [scrollWidth, innerWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  await page.locator('[data-testid=odds-button]:not([disabled])').first().click();
  await page.getByTestId('mobile-slip-button').click();
  await expect(page.getByRole('dialog').getByTestId('slip-item')).toHaveCount(1);
});
