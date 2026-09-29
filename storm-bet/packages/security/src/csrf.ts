import { generateToken, hmac, safeEqual } from './tokens';

/**
 * CSRF tokens bound to the session: `<nonce>.<hmac(secret, sessionKey|nonce)>`.
 * The token is readable by the page (double-submit cookie) but cannot be
 * minted for another session without the server secret.
 */
export function createCsrfToken(secret: string, sessionKey: string): string {
  const nonce = generateToken(16);
  return `${nonce}.${hmac(secret, `${sessionKey}|${nonce}`)}`;
}

export function verifyCsrfToken(secret: string, sessionKey: string, token: string): boolean {
  const [nonce, mac, extra] = token.split('.');
  if (!nonce || !mac || extra !== undefined) return false;
  return safeEqual(mac, hmac(secret, `${sessionKey}|${nonce}`));
}
