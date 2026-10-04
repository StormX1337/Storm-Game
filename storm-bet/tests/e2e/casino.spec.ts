import { expect, test } from './fixtures';
import { ADMIN_EMAIL, ADMIN_PASSWORD, expectNoHorizontalOverflow, login } from './helpers';

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
    // A natural blackjack ends the hand at once; otherwise stand.
    if (await stand.isVisible()) await stand.click();
    await expect(page.getByTestId('deal')).toBeVisible();
  });

  test('crash, plinko and mines play on the server', async ({ page }) => {
    await signIn(page);
    const open = async (name: string) => {
      await page.goto('/casino');
      await page
        .getByTestId('game-card')
        .filter({ hasText: name })
        .getByRole('link', { name: /Demo spielen/ })
        .first()
        .click();
      await expect(page.getByTestId('game-controls')).toBeVisible();
    };
    const played = () =>
      page.waitForResponse((r) => r.url().includes('/play') && r.request().method() === 'POST');

    await open('Storm Crash');
    let play = played();
    await page.getByTestId('crash-play').click();
    expect((await play).status()).toBe(201);

    await open('Storm Plinko');
    play = played();
    await page.getByTestId('plinko-drop').click();
    expect((await play).status()).toBe(201);

    await open('Storm Mines');
    // A round left open by an earlier run is resumed; cash it out first.
    const cashout = page.getByTestId('mines-cashout');
    if (await cashout.isVisible()) await cashout.click();
    play = played();
    await page.getByTestId('mines-start').click();
    expect((await play).status()).toBe(201);
    await expect(cashout).toBeVisible();
    play = played();
    await page.getByTestId('mines-tile').first().click();
    expect((await play).status()).toBe(201);
    // Either a mine ended the round or it goes on and can be cashed out.
    if (await cashout.isVisible()) await cashout.click();
    await expect(page.getByTestId('mines-start')).toBeVisible();
  });

  test('dice, keno, wheel, hi-lo and video poker play on the server', async ({ page }) => {
    await signIn(page);
    const open = async (name: string) => {
      await page.goto('/casino');
      await page
        .getByTestId('game-card')
        .filter({ hasText: name })
        .getByRole('link', { name: /Demo spielen/ })
        .first()
        .click();
      await expect(page.getByTestId('game-controls')).toBeVisible();
    };
    const played = () =>
      page.waitForResponse((r) => r.url().includes('/play') && r.request().method() === 'POST');
    const press = async (testId: string) => {
      const res = played();
      await page.getByTestId(testId).click();
      expect((await res).status()).toBe(201);
    };

    await open('Storm Dice');
    await press('dice-play');
    await expect(page.getByTestId('dice-roll')).not.toHaveText('–');

    await open('Storm Keno');
    await page.getByTestId('keno-number').nth(4).click();
    await page.getByTestId('keno-number').nth(17).click();
    await press('keno-play');

    await open('Glücksrad');
    await press('wheel-spin');
    await expect(page.getByTestId('wheel-result')).not.toHaveText('?', { timeout: 6_000 });

    await open('Storm Hi-Lo');
    const hiloCashout = page.getByTestId('hilo-cashout');
    if (!(await hiloCashout.isVisible())) await press('hilo-start');
    await expect(hiloCashout).toBeVisible();
    // Guess the likelier side; a wrong guess ends the round, a right one can be cashed out.
    const higher = page.getByTestId('hilo-higher');
    await press((await higher.isEnabled()) ? 'hilo-higher' : 'hilo-lower');
    if ((await hiloCashout.isVisible()) && (await hiloCashout.isEnabled()))
      await press('hilo-cashout');

    await open('Jacks or Better');
    if (!(await page.getByTestId('poker-draw').isVisible())) await press('poker-deal');
    await page.getByTestId('poker-card').first().click();
    await press('poker-draw');
    await expect(page.getByTestId('poker-deal')).toBeVisible();
  });
});

test('mobile casino: no horizontal overflow and the tab bar @mobile', async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId('game-card').first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(page.getByRole('navigation', { name: 'Schnellnavigation' })).toBeVisible();
});
