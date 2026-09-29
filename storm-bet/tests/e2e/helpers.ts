import { expect, type Page } from '@playwright/test';

export const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@storm-bet.local';
export const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'Admin-Storm-2026!';

export async function login(page: Page, email: string, password: string, next?: string) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  await page.getByLabel('E-Mail-Adresse').fill(email);
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('user-menu')).toBeVisible();
}

export async function register(page: Page, email: string, password: string, name = 'E2E Spieler') {
  await page.goto('/register');
  await page.getByLabel('E-Mail-Adresse').fill(email);
  await page.getByLabel('Anzeigename').fill(name);
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByTestId('age-confirm').check();
  await page.getByTestId('terms-accept').check();
  await page.getByTestId('register-submit').click();
  await expect(page).toHaveURL(/\/dashboard\?welcome=1/);
}

/** Opens the first upcoming (not yet live) event of a sport. */
export async function openUpcomingEvent(page: Page, sport = 'football') {
  await page.goto(`/sports/${sport}`);
  const row = page
    .getByTestId('event-row')
    .filter({ hasNot: page.getByText('Live', { exact: true }) })
    .first();
  await row.getByTestId('event-link').click();
  await expect(page.getByTestId('market-card').first()).toBeVisible();
}

/**
 * Places a bet with the first open selection. Simulated prices move; when the
 * slip reports an updated price the test accepts it the way a player would —
 * explicitly, never automatically.
 */
export async function placeFirstOpenSelection(page: Page, stake: string) {
  await page.locator('[data-testid=odds-button]:not([disabled])').first().click();
  await expect(page.getByTestId('slip-item')).toHaveCount(1);
  await page.getByTestId('stake-input').fill(stake);
  const receipt = page.getByTestId('bet-receipt');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.waitForTimeout(500); // debounce of the server-side quote
    if (await receipt.isVisible()) return;
    if (await page.getByTestId('odds-changed').isVisible()) {
      await page.getByRole('button', { name: 'Neue Quoten übernehmen' }).click();
      continue;
    }
    if (await page.getByTestId('place-bet').isEnabled()) {
      await page.getByTestId('place-bet').click();
      const placed = await receipt
        .waitFor({ state: 'visible', timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
      if (placed) return;
    }
  }
  await expect(receipt).toBeVisible();
}
