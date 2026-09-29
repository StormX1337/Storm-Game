import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, login } from './helpers';

// Staff accounts can play too; logging in avoids the registration rate limit.
const signIn = (page: Parameters<typeof login>[0]) =>
  login(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/casino');

test.describe('casino', () => {
  test('lobby, a server-decided spin and the round in the history', async ({ page }) => {
    await signIn(page);
    await expect(page.getByTestId('casino-demo-mode')).toHaveText('DEMO MODE – No real money');
    await expect(page.getByTestId('game-card').first()).toBeVisible();

    await page.getByPlaceholder('Spiel oder Anbieter suchen').fill('Storm Surge');
    await page
      .getByTestId('game-card')
      .filter({ hasText: 'Storm Surge' })
      .getByRole('link', { name: /Demo spielen/ })
      .first()
      .click();
    await expect(page.getByTestId('game-area')).toBeVisible();
    const play = page.waitForResponse(
      (r) => r.url().includes('/play') && r.request().method() === 'POST',
    );
    await page.getByTestId('spin').click();
    expect((await play).status()).toBe(201);
    await expect(page.getByTestId('spin')).toBeEnabled();

    await page.goto('/casino/history');
    await expect(page.getByTestId('casino-round').first()).toContainText('Storm Surge');
  });

  test('blackjack deals from the server', async ({ page }) => {
    await signIn(page);
    await page
      .getByTestId('game-card')
      .filter({ hasText: 'Blackjack Classic' })
      .getByRole('link', { name: /Demo spielen/ })
      .first()
      .click();
    await expect(page.getByTestId('game-controls')).toBeVisible();
    // A hand left open by an earlier run is resumed; finish it first.
    const stand = page.getByRole('button', { name: 'Stehen' });
    if (await stand.isVisible()) await stand.click();
    await page.getByTestId('deal').click();
    await expect(page.getByTestId('blackjack-table')).toBeVisible();
    if (await stand.isEnabled().catch(() => false)) await stand.click();
    await expect(page.getByTestId('deal')).toBeVisible();
  });
});

test('mobile casino: no horizontal overflow and the tab bar @mobile', async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId('game-card').first()).toBeVisible();
  const [scrollWidth, innerWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  await expect(page.getByRole('navigation', { name: 'Schnellnavigation' })).toBeVisible();
});
