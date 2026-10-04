import { randomUUID } from 'node:crypto';
import { clientIp, expect, test } from './fixtures';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  expectNoHorizontalOverflow,
  login,
  openUpcomingEvent,
  placeFirstOpenSelection,
  placeSlip,
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

  test('three picks on different matches can be played as a system bet', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/sports/football');
    const rows = page
      .getByTestId('event-row')
      .filter({ hasNot: page.getByText('Live', { exact: true }) });
    for (let i = 0; i < 3; i += 1) {
      await rows.nth(i).locator('[data-testid=odds-button]:not([disabled])').first().click();
    }
    await expect(page.getByTestId('slip-item')).toHaveCount(3);
    await page.getByRole('tab', { name: 'System' }).click();
    await page.getByTestId('system-size').filter({ hasText: '2 aus 3' }).click();
    await page.getByTestId('stake-input').fill('1');
    await expect(page.getByText('Einsatz (3 Wetten)')).toBeVisible();
    await placeSlip(page, '1');
    await expect(page.getByTestId('bet-receipt')).toContainText('Systemwette');
  });

  test('two picks on one match become a Bet Builder with one price', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await openUpcomingEvent(page);
    const pick = (market: string) =>
      page
        .getByTestId('market-card')
        .filter({ hasText: market })
        .first()
        .locator('[data-testid=odds-button]:not([disabled])')
        .first();
    await pick('Ergebnis (1X2)').click();
    await pick('Beide Teams treffen').click();
    await expect(page.getByTestId('slip-item')).toHaveCount(2);
    await expect(page.getByRole('tab', { name: 'Bet Builder' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByTestId('builder-info')).toBeVisible();
    await expect(page.getByTestId('total-odds')).not.toHaveText('–');
    await placeSlip(page, '5');
    await expect(page.getByTestId('bet-receipt')).toBeVisible();
    await page.goto('/dashboard/bets');
    await expect(page.getByTestId('bet-card').first()).toContainText('Bet Builder');
  });

  test('an open bet can be cashed out at its current value', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await openUpcomingEvent(page);
    await placeFirstOpenSelection(page, '3');
    const reference = (await page
      .getByTestId('bet-receipt')
      .locator('.font-mono')
      .first()
      .textContent())!;
    await page.goto('/dashboard/bets');
    const card = page.getByTestId('bet-card').filter({ hasText: reference });
    await card.getByTestId('cashout-button').click();
    // A moved value asks again; the player confirms explicitly each time.
    const done = page.getByText(/Cashout: .* gutgeschrieben/);
    const confirm = card.getByTestId('cashout-confirm');
    for (let attempt = 0; attempt < 3 && (await confirm.isVisible()); attempt += 1) {
      await confirm.click();
      const paid = await done
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (paid) break;
    }
    await page.reload();
    await expect(page.getByTestId('bet-card').filter({ hasText: reference })).toContainText(
      'Ausgezahlt',
    );
  });

  test('a live bet goes through although live prices keep moving', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/live');
    await placeFirstOpenSelection(page, '2');
    await expect(page.getByTestId('bet-receipt')).toBeVisible();
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

    const player = await browser.newPage({ extraHTTPHeaders: { 'x-forwarded-for': clientIp() } });
    await register(player, uniqueEmail(), PASSWORD, 'Kein Admin');
    const res = await player.goto('/admin');
    expect(res!.status()).toBe(404);
    await player.close();
  });
});

test('mobile: no horizontal overflow and the sticky slip opens @mobile', async ({ page }) => {
  await page.goto('/sports/tennis');
  await expectNoHorizontalOverflow(page);
  await page.locator('[data-testid=odds-button]:not([disabled])').first().click();
  await page.getByTestId('mobile-slip-button').click();
  await expect(page.getByRole('dialog').getByTestId('slip-item')).toHaveCount(1);
});

test('a bet shared in the tip feed can be copied by another player', async ({ page, browser }) => {
  const author = `Tipper ${randomUUID().slice(0, 6)}`;
  await register(page, uniqueEmail(), PASSWORD, author);
  await openUpcomingEvent(page);
  await placeFirstOpenSelection(page, '2');
  await page.goto('/dashboard/bets');
  await page.getByTestId('feed-toggle').first().click();
  await expect(page.getByTestId('feed-toggle').first()).toContainText('Im Feed · entfernen');

  const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': clientIp() } });
  const other = await ctx.newPage();
  await register(other, uniqueEmail(), PASSWORD, 'Mitleser');
  await other.goto('/feed');
  // Scoped to <main>: streamed HTML briefly holds a hidden copy of the list.
  const card = other.getByRole('main').getByTestId('feed-card').filter({ hasText: author });
  await expect(card).toHaveCount(1);
  await expect(card).not.toContainText('2,00 €');
  await card.getByTestId('feed-copy').click();
  await expect(other).toHaveURL(/\/share\?ids=/);
  await other.getByTestId('take-shared').click();
  await expect(other.getByTestId('slip-item')).toHaveCount(1);
  await ctx.close();
});

test('search finds events by team name', async ({ page }) => {
  await page.goto('/sports/football');
  const team = (await page
    .getByTestId('event-link')
    .first()
    .locator('.truncate.text-sm')
    .first()
    .textContent())!.trim();
  const term = team.split(/\s+/).find((w) => w.length >= 3) ?? team;
  await page.getByTestId('search-link').click();
  await page.getByTestId('search-input').fill(term);
  await expect(page.getByTestId('event-row').first()).toContainText(term);
  await expect(page).toHaveURL(new RegExp(`/search\\?q=`));
});

test('mobile: app-style home with top matches, tiles and tab bar @mobile', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('top-match').first()).toBeVisible();
  await expect(page.getByTestId('quick-tile').first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByTestId('tab-casino').click();
  await expect(page).toHaveURL(/\/(casino|login)/);
});
