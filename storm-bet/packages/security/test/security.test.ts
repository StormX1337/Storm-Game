import { describe, expect, it } from 'vitest';
import {
  createCsrfToken,
  generateReference,
  hashPassword,
  ipAllowed,
  ipInCidr,
  needsRehash,
  safeEqual,
  verifyCsrfToken,
  verifyPassword,
} from '../src';

describe('password hashing', () => {
  it('hashes with argon2id and verifies', async () => {
    const digest = await hashPassword('correct horse battery');
    expect(digest.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(digest, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(digest, 'wrong')).toBe(false);
    expect(needsRehash(digest)).toBe(false);
  });

  it('treats malformed hashes as a failed login', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever')).toBe(false);
    expect(needsRehash('$argon2i$v=19$m=4096,t=3,p=1$abc$def')).toBe(true);
  });
});

describe('csrf tokens', () => {
  it('bind to the session', () => {
    const token = createCsrfToken('s'.repeat(32), 'session-a');
    expect(verifyCsrfToken('s'.repeat(32), 'session-a', token)).toBe(true);
    expect(verifyCsrfToken('s'.repeat(32), 'session-b', token)).toBe(false);
    expect(verifyCsrfToken('t'.repeat(32), 'session-a', token)).toBe(false);
    expect(verifyCsrfToken('s'.repeat(32), 'session-a', `${token}.x`)).toBe(false);
  });
});

describe('helpers', () => {
  it('compares in constant time semantics', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('generates readable references', () => {
    expect(generateReference('SB')).toMatch(/^SB-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('matches CIDRs', () => {
    expect(ipInCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('::ffff:10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipInCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(ipAllowed('1.2.3.4', [])).toBe(true);
    expect(ipAllowed('1.2.3.4', ['1.2.3.4'])).toBe(true);
    expect(ipAllowed('1.2.3.5', ['1.2.3.4'])).toBe(false);
  });
});
