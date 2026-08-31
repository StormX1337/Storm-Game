import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { JwtError, signJwt, verifyJwt } from '../src/lib/jwt.js';
import { createTestApp } from './helpers.js';

/**
 * The access token verifier, attacked deliberately.
 *
 * It is hand-written rather than pulled from a library, which is the right call
 * here — the algorithm is pinned at both ends by construction — but it also
 * means nobody else's test suite covers it. A flaw is not a bug in a feature;
 * it is every session in the panel.
 */
describe('access tokens', () => {
  const SECRET = 'a-secret-long-enough-to-be-realistic-0123456789';
  const ISSUER = 'storm-panel';

  const claims = {
    sub: 'user_123',
    sid: 'session_456',
    role: 'OWNER',
    iss: ISSUER,
    typ: 'access' as const,
  };

  /** Re-encodes a token with a different header or payload, keeping its parts. */
  function reassemble(token: string, parts: { header?: unknown; payload?: unknown }): string {
    const [h, p, s] = token.split('.') as [string, string, string];
    const header = parts.header
      ? Buffer.from(JSON.stringify(parts.header)).toString('base64url')
      : h;
    const payload = parts.payload
      ? Buffer.from(JSON.stringify(parts.payload)).toString('base64url')
      : p;
    return `${header}.${payload}.${s}`;
  }

  function decode(token: string): Record<string, unknown> {
    const body = token.split('.')[1] as string;
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  }

  it('round-trips the claims it was given', () => {
    const token = signJwt(SECRET, claims, 900);
    const payload = verifyJwt(SECRET, token, ISSUER);

    assert.equal(payload.sub, 'user_123');
    assert.equal(payload.sid, 'session_456');
    assert.equal(payload.role, 'OWNER');
    assert.equal(payload.typ, 'access');
    assert.equal(payload.exp - payload.iat, 900);
  });

  it('refuses a token signed with a different secret', () => {
    const forged = signJwt('a-different-secret-of-the-same-sort-0123456789', claims, 900);
    assert.throws(() => verifyJwt(SECRET, forged, ISSUER), JwtError);
  });

  it('refuses alg: none, however it is spelled', () => {
    const token = signJwt(SECRET, claims, 900);

    for (const header of [
      { alg: 'none', typ: 'JWT' },
      { alg: 'None', typ: 'JWT' },
      { alg: 'NONE', typ: 'JWT' },
      { alg: '', typ: 'JWT' },
    ]) {
      assert.throws(
        () => verifyJwt(SECRET, reassemble(token, { header }), ISSUER),
        JwtError,
        `accepted ${JSON.stringify(header)}`,
      );
    }
  });

  it('refuses an asymmetric algorithm, closing RS256 to HS256 confusion', () => {
    // The attack is to claim RS256 and sign with the public key as an HMAC key.
    // Pinning the header literally means the claim never gets read at all.
    const token = signJwt(SECRET, claims, 900);
    for (const alg of ['RS256', 'ES256', 'PS256', 'HS384', 'HS512']) {
      assert.throws(
        () => verifyJwt(SECRET, reassemble(token, { header: { alg, typ: 'JWT' } }), ISSUER),
        JwtError,
        `accepted ${alg}`,
      );
    }
  });

  it('refuses a header that reorders the same fields', () => {
    // We generate the header, so anything but our exact bytes is not ours —
    // and accepting a re-encoding would mean parsing attacker-chosen JSON to
    // decide how to verify.
    const token = signJwt(SECRET, claims, 900);
    const reordered = reassemble(token, { header: { typ: 'JWT', alg: 'HS256' } });
    assert.throws(() => verifyJwt(SECRET, reordered, ISSUER), JwtError);
  });

  it('refuses a payload edited after signing', () => {
    const token = signJwt(SECRET, { ...claims, role: 'CUSTOMER' }, 900);
    const escalated = reassemble(token, {
      payload: { ...decode(token), role: 'OWNER' },
    });

    assert.throws(() => verifyJwt(SECRET, escalated, ISSUER), JwtError);
  });

  it('refuses a token with no signature at all', () => {
    const token = signJwt(SECRET, claims, 900);
    const [h, p] = token.split('.') as [string, string];

    assert.throws(() => verifyJwt(SECRET, `${h}.${p}`, ISSUER), JwtError, 'two parts accepted');
    assert.throws(() => verifyJwt(SECRET, `${h}.${p}.`, ISSUER), JwtError, 'empty signature');
    assert.throws(() => verifyJwt(SECRET, `${h}.${p}.${h}.${p}`, ISSUER), JwtError, 'four parts');
    assert.throws(() => verifyJwt(SECRET, '', ISSUER), JwtError);
  });

  it('refuses a signature of the right shape but the wrong content', () => {
    const token = signJwt(SECRET, claims, 900);
    const [h, p, s] = token.split('.') as [string, string, string];

    // Same length, so a length check alone would not catch it.
    const flipped = `${s.slice(0, -1)}${s.at(-1) === 'A' ? 'B' : 'A'}`;
    assert.notEqual(flipped, s);
    assert.throws(() => verifyJwt(SECRET, `${h}.${p}.${flipped}`, ISSUER), JwtError);

    // A signature over the payload alone, not header.payload.
    const partial = createHmac('sha256', SECRET).update(p).digest('base64url');
    assert.throws(() => verifyJwt(SECRET, `${h}.${p}.${partial}`, ISSUER), JwtError);
  });

  it('refuses an expired token', () => {
    const token = signJwt(SECRET, { ...claims, iat: Math.floor(Date.now() / 1000) - 3600 }, 60);
    assert.throws(() => verifyJwt(SECRET, token, ISSUER), /expired/i);
  });

  it('refuses a token dated far in the future', () => {
    // A clock a minute out is tolerated; an hour is someone choosing their own
    // issue time to extend a session.
    const soon = signJwt(SECRET, { ...claims, iat: Math.floor(Date.now() / 1000) + 30 }, 900);
    assert.doesNotThrow(() => verifyJwt(SECRET, soon, ISSUER));

    const later = signJwt(SECRET, { ...claims, iat: Math.floor(Date.now() / 1000) + 3600 }, 900);
    assert.throws(() => verifyJwt(SECRET, later, ISSUER), /not yet valid/i);
  });

  it('refuses a token minted for another issuer', () => {
    const token = signJwt(SECRET, { ...claims, iss: 'some-other-panel' }, 900);
    assert.throws(() => verifyJwt(SECRET, token, ISSUER), /issuer/i);
  });

  it('refuses a token with no subject to attribute it to', () => {
    for (const sub of ['', undefined, null, 42, {}]) {
      const token = signJwt(SECRET, { ...claims, sub } as never, 900);
      assert.throws(() => verifyJwt(SECRET, token, ISSUER), JwtError, `accepted sub=${sub}`);
    }
  });

  it('refuses a payload that is not JSON, or not an object', () => {
    const token = signJwt(SECRET, claims, 900);
    const [h] = token.split('.') as [string];

    for (const body of ['not json', '[]', '"a string"', 'null', '123']) {
      const encoded = Buffer.from(body).toString('base64url');
      const signature = createHmac('sha256', SECRET).update(`${h}.${encoded}`).digest('base64url');
      assert.throws(
        () => verifyJwt(SECRET, `${h}.${encoded}.${signature}`, ISSUER),
        JwtError,
        `accepted payload ${body}`,
      );
    }
  });
});

/**
 * The same thing seen from a request. A verifier that throws the wrong error
 * type does not fail visibly in its own tests — it fails as a 500 on a route,
 * which reads as the panel breaking rather than the token being rejected.
 */
describe('a malformed token on a real request', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;
  });

  after(async () => {
    await cleanup();
  });

  /** A correctly signed token whose payload is not an object. */
  function tokenWithPayload(body: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const encoded = Buffer.from(body).toString('base64url');
    const signature = createHmac('sha256', app.env.JWT_SECRET)
      .update(`${header}.${encoded}`)
      .digest('base64url');
    return `${header}.${encoded}.${signature}`;
  }

  it('answers 401, not 500, whatever the payload turns out to be', async () => {
    for (const body of ['null', '[]', '"a string"', '123', 'not json']) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${tokenWithPayload(body)}` },
      });

      assert.equal(response.statusCode, 401, `payload ${body} gave ${response.statusCode}`);
      assert.doesNotMatch(response.body, /went wrong on our side/);
    }
  });

  it('answers 401 for a token that is not a token at all', async () => {
    for (const token of ['', 'nonsense', 'a.b.c', '...', 'Bearer']) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.statusCode, 401, `"${token}" gave ${response.statusCode}`);
    }
  });
});
