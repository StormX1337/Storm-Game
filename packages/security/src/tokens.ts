import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

const URL_SAFE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Cryptographically strong URL-safe token. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Human-friendly identifier without ambiguous characters (no 0/O/1/l/I). */
export function generateReadableId(length = 8): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += URL_SAFE_ALPHABET[randomInt(0, URL_SAFE_ALPHABET.length)];
  }
  return out;
}

export function generateUuid(): string {
  return randomUUID();
}

/**
 * Tokens are stored as SHA-256 digests. They are already high-entropy random
 * values, so a slow KDF buys nothing here — the digest only prevents a database
 * leak from handing out usable session/API credentials.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the timing does not reveal length mismatches.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Generates a password suitable for generated database/SFTP accounts. */
export function generatePassword(length = 24): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^&*-_=+';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[randomInt(0, alphabet.length)];
  }
  return out;
}

/** Backup codes for 2FA: 10 groups of `xxxx-xxxx`. */
export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = generateReadableId(8).toLowerCase();
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}
