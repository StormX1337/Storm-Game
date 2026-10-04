import { createHmac, randomUUID } from 'node:crypto';
import { clientIp, expect, test } from './fixtures';
import { register } from './helpers';

/** RFC 6238 code for a base32 secret (what an authenticator app shows). */
function totp(secret: string, step: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secret) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const step = () => Math.floor(Date.now() / 30_000);

test('two-factor login: set up with an authenticator, then log in with a code', async ({
  page,
  browser,
}) => {
  const email = `e2e-2fa-${randomUUID().slice(0, 8)}@test.local`;
  const password = 'E2e-Passwort-2026';
  await register(page, email, password);
  await page.goto('/dashboard/security');
  await page.getByTestId('totp-setup').click();
  await page.getByLabel('Passwort zur Bestätigung').fill(password);
  await page.getByRole('button', { name: 'Weiter' }).click();
  await expect(page.getByTestId('totp-qr')).toBeVisible();
  const secret = (await page.getByTestId('totp-secret').textContent())!.trim();
  await page.getByTestId('totp-code').fill(totp(secret, step()));
  await page.getByTestId('totp-enable').click();
  await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);

  const fresh = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': clientIp() } });
  const other = await fresh.newPage();
  await other.goto('/login');
  await other.getByLabel('E-Mail-Adresse').fill(email);
  await other.getByLabel('Passwort', { exact: true }).fill(password);
  await other.getByTestId('login-submit').click();
  await other.getByTestId('otp-input').fill(totp(secret, step() + 1));
  await other.getByTestId('otp-submit').click();
  await expect(other.getByTestId('user-menu')).toBeVisible();
  await fresh.close();
});

test('the language switch turns the site English and back', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Jetzt wetten' })).toBeVisible();
  await page.getByTestId('lang-en').first().click();
  await expect(page.getByRole('heading', { name: 'Bet now' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByTestId('lang-de').first().click();
  await expect(page.getByRole('heading', { name: 'Jetzt wetten' })).toBeVisible();
});
