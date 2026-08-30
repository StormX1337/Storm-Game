import { authenticator } from 'otplib';

authenticator.options = { window: [1, 1], step: 30, digits: 6 };

export function generateTotpSecret(): string {
  return authenticator.generateSecret(20);
}

export function buildTotpUri(secret: string, account: string, issuer: string): string {
  return authenticator.keyuri(account, issuer, secret);
}

/**
 * The code a correctly-enrolled authenticator would be showing right now.
 *
 * Not used to authenticate anyone — it exists so tests can prove that a secret
 * the panel issued, and encoded into the setup QR, actually produces codes the
 * panel accepts.
 */
export function generateTotp(secret: string): string {
  return authenticator.generate(secret);
}

export function verifyTotp(secret: string, token: string): boolean {
  if (!secret || !token) return false;
  const cleaned = token.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  try {
    return authenticator.verify({ token: cleaned, secret });
  } catch {
    return false;
  }
}
