import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** 256-bit URL-safe random token. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Tokens are high-entropy random values, so a fast digest is enough: it only
 * keeps a database leak from handing out working sessions or reset links.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Human-readable id without 0/O/1/I, e.g. bet references "SB-7KQ2-M9XD". */
export function generateReference(prefix: string, groups = 2, groupLength = 4): string {
  const parts: string[] = [];
  for (let g = 0; g < groups; g += 1) {
    let part = '';
    for (let i = 0; i < groupLength; i += 1) {
      part += REFERENCE_ALPHABET[randomInt(0, REFERENCE_ALPHABET.length)];
    }
    parts.push(part);
  }
  return `${prefix}-${parts.join('-')}`;
}

/** Password for generated accounts (seed output). */
export function generatePassword(length = 20): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_!';
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[randomInt(0, alphabet.length)];
  return out;
}
