import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  totpCode,
  verifyTotp,
} from '../src';

// RFC 6238 appendix B: ASCII "12345678901234567890", SHA-1, 8 digits → last 6 here.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors', () => {
    expect(totpCode(RFC_SECRET, Math.floor(59 / 30))).toBe('287082');
    expect(totpCode(RFC_SECRET, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpCode(RFC_SECRET, Math.floor(1234567890 / 30))).toBe('005924');
    expect(totpCode(RFC_SECRET, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('accepts one step of drift and never the same step twice', () => {
    const secret = generateTotpSecret();
    const now = new Date('2026-10-01T12:00:10Z');
    const step = Math.floor(now.getTime() / 30_000);
    expect(verifyTotp(secret, totpCode(secret, step), now)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), now)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step), now, step)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });

  it('round-trips base32, sealed secrets and recovery codes', () => {
    const raw = Buffer.from('any bytes ÿ\u0000', 'latin1');
    expect(base32Decode(base32Encode(raw))).toEqual(raw);
    const secret = generateTotpSecret();
    const sealed = encryptSecret(secret, 'x'.repeat(40));
    expect(sealed).not.toContain(secret);
    expect(decryptSecret(sealed, 'x'.repeat(40))).toBe(secret);
    expect(() => decryptSecret(sealed, 'y'.repeat(40))).toThrow();
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
    expect(hashRecoveryCode(` ${codes[0]!.toUpperCase()} `)).toBe(hashRecoveryCode(codes[0]!));
    expect(otpauthUri(secret, 'a@b.de', 'STORM BET')).toMatch(
      /^otpauth:\/\/totp\/STORM%20BET%3Aa%40b\.de\?secret=/,
    );
  });
});
