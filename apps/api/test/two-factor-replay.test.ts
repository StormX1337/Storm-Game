import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { generateTotp, generateTotpSecret, hashToken } from '@storm/security';
import { createTestApp, deleteUser, registerUser } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * A six-digit code opens the account once.
 *
 * A TOTP code is valid for its own thirty-second step and the one either side,
 * so the number on the screen is good for a minute and a half. Being read off
 * that screen — over a shoulder, on a shared call, through a phishing page —
 * is most of what a second factor is defending against, and until now the same
 * digits could be spent twice inside that window. RFC 6238 §5.2 says a
 * verifier must not accept a code it has already accepted.
 *
 * "Already used" is answered separately from "not valid", because the two mean
 * different things to the person holding the phone, and a panel that says the
 * wrong one produces a support ticket claiming two-factor is broken.
 */
describe('two-factor codes are spent when they are used', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let user: RegisteredUser;
  let secret: string;
  const createdUsers: string[] = [];

  /** Enables 2FA directly, so these tests are about verifying, not enrolling. */
  async function enable(): Promise<void> {
    secret = generateTotpSecret();
    await app.prisma.twoFactorAuth.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        secretEnc: app.encrypter.encrypt(secret),
        enabled: true,
        confirmedAt: new Date(),
        backupCodes: [hashToken('rescue-code-one'), hashToken('rescue-code-two')],
      },
      update: {
        secretEnc: app.encrypter.encrypt(secret),
        enabled: true,
        confirmedAt: new Date(),
        backupCodes: [hashToken('rescue-code-one'), hashToken('rescue-code-two')],
      },
    });
  }

  const login = (totp?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: user.email, password: user.password, ...(totp ? { totp } : {}) },
    });

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;
    user = await registerUser(app);
    createdUsers.push(user.id);
  });

  after(async () => {
    await app.prisma.twoFactorAuth.deleteMany({ where: { userId: user.id } });
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    await enable();
    // Nothing spent from an earlier test in this file.
    const keys = await app.redis.keys(`storm:totp-spent:${user.id}:*`);
    if (keys.length > 0) await app.redis.del(...keys);
  });

  it('lets the right code in', async () => {
    const response = await login(generateTotp(secret));
    assert.equal(response.statusCode, 200, response.body);
  });

  it('refuses the same code a second time', async () => {
    // The whole point: somebody who read the code off the screen has ninety
    // seconds of it being valid, and this is what stops them spending it.
    const code = generateTotp(secret);
    assert.equal((await login(code)).statusCode, 200);

    const again = await login(code);
    assert.equal(again.statusCode, 401, again.body);
    assert.match(again.body, /already been used/i, 'said the code was wrong, which it was not');
  });

  it('still refuses a code that was never right', async () => {
    const response = await login('000000');
    assert.equal(response.statusCode, 401, response.body);
    assert.match(response.body, /not valid/i);
    assert.doesNotMatch(response.body, /already been used/i);
  });

  it('does not spend a code on the wrong password', async () => {
    // The password is checked first, so a typo must not burn the code the
    // person is about to type again correctly.
    const code = generateTotp(secret);
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: user.email, password: 'NotThePassword1!', totp: code },
    });
    assert.equal(wrong.statusCode, 401, wrong.body);

    const right = await login(code);
    assert.equal(right.statusCode, 200, `the typo spent the code: ${right.body}`);
  });

  it('spends one account’s code without touching another’s', async () => {
    // The same six digits come up for different people all day; one person
    // signing in must not lock the next one out.
    const other = await registerUser(app);
    createdUsers.push(other.id);
    await app.prisma.twoFactorAuth.create({
      data: {
        userId: other.id,
        secretEnc: app.encrypter.encrypt(secret),
        enabled: true,
        confirmedAt: new Date(),
      },
    });

    const code = generateTotp(secret);
    assert.equal((await login(code)).statusCode, 200);

    const theirs = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: other.email, password: other.password, totp: code },
    });
    assert.equal(theirs.statusCode, 200, theirs.body);
  });

  it('forgets a spent code once it could no longer work anyway', async () => {
    // Held only for as long as the code is valid: a store that grew forever
    // would be a list of every code every account has ever used.
    const code = generateTotp(secret);
    await login(code);

    const [key] = await app.redis.keys(`storm:totp-spent:${user.id}:*`);
    assert.ok(key, 'nothing was recorded as spent');
    const ttl = await app.redis.ttl(key);
    assert.ok(ttl > 0 && ttl <= 180, `${ttl}s is not the life of a code`);
  });

  it('keeps the code itself out of the store', async () => {
    // Live one-time codes sitting in Redis for ninety seconds is a store worth
    // stealing; a digest of one is not.
    const code = generateTotp(secret);
    await login(code);

    const [key] = await app.redis.keys(`storm:totp-spent:${user.id}:*`);
    assert.ok(key);
    assert.ok(!key.includes(code), 'the code is readable in the key');
  });

  it('still takes a backup code, and still only once', async () => {
    const first = await login('rescue-code-one');
    assert.equal(first.statusCode, 200, first.body);

    const again = await login('rescue-code-one');
    assert.equal(again.statusCode, 401, again.body);
  });

  it('will not turn two-factor off with a code that already signed someone in', async () => {
    const code = generateTotp(secret);
    const session = await login(code);
    assert.equal(session.statusCode, 200, session.body);
    const token = session.json<{ data: { accessToken: string } }>().data.accessToken;

    const disable = await app.inject({
      method: 'POST',
      url: '/api/v1/account/2fa/disable',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: user.password, code },
    });
    assert.equal(disable.statusCode, 400, disable.body);
    assert.match(disable.body, /already been used/i);

    const stillOn = await app.prisma.twoFactorAuth.findUnique({ where: { userId: user.id } });
    assert.equal(stillOn?.enabled, true, 'two-factor was turned off by a spent code');
  });

  it('spends the code that switched two-factor on', async () => {
    // Enrolment is a use like any other: the code that turned it on must not
    // still open the account a moment later.
    await app.prisma.twoFactorAuth.deleteMany({ where: { userId: user.id } });
    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: user.email, password: user.password },
    });
    const token = session.json<{ data: { accessToken: string } }>().data.accessToken;

    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/account/2fa/setup',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: user.password },
    });
    assert.equal(setup.statusCode, 200, setup.body);
    const enrolmentSecret = setup.json<{ data: { secret: string } }>().data.secret;

    const code = generateTotp(enrolmentSecret);
    const enabled = await app.inject({
      method: 'POST',
      url: '/api/v1/account/2fa/enable',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: user.password, code },
    });
    assert.equal(enabled.statusCode, 200, enabled.body);

    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: user.email, password: user.password, totp: code },
    });
    assert.equal(reuse.statusCode, 401, reuse.body);
    assert.match(reuse.body, /already been used/i);
  });
});
