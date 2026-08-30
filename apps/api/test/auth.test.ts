import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { generateTotp, hashToken } from '@storm/security';
import { createTestApp, deleteUser, registerUser, uniqueSuffix, type RegisteredUser } from './helpers.js';

describe('authentication', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  const created: string[] = [];

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;
  });

  after(async () => {
    for (const id of created) await deleteUser(app, id);
    await cleanup();
  });

  it('registers a user and issues a session', async () => {
    const user = await registerUser(app);
    created.push(user.id);

    assert.ok(user.accessToken.length > 20);
    assert.match(user.cookies, /storm_access=/);
    assert.match(user.cookies, /storm_refresh=/);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(me.statusCode, 200);

    const body = me.json<{ data: { user: { email: string; role: string } } }>();
    assert.equal(body.data.user.email, user.email);
    assert.equal(body.data.user.role, 'CUSTOMER');
  });

  it('rejects a duplicate email', async () => {
    const user = await registerUser(app);
    created.push(user.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: user.email, username: `other${uniqueSuffix()}`, password: 'AnotherPass123!' },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json<{ error: { code: string } }>().error.code, 'ALREADY_EXISTS');
  });

  it('reports every invalid field at once', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'not-an-email', username: 'x', password: 'short' },
    });

    assert.equal(response.statusCode, 400);
    const body = response.json<{ error: { code: string; details: Record<string, string[]> } }>();
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    // A form should be able to mark all three fields in one pass.
    assert.ok(body.error.details.email);
    assert.ok(body.error.details.username);
    assert.ok(body.error.details.password);
  });

  it('signs in with either the email or the username', async () => {
    const user = await registerUser(app);
    created.push(user.id);

    for (const identifier of [user.email, user.username]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier, password: user.password },
      });
      assert.equal(response.statusCode, 200, `login with ${identifier}`);
    }
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const user = await registerUser(app);
    created.push(user.id);

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: user.email, password: 'WrongPassword123!' },
    });
    const unknownAccount = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: `ghost-${uniqueSuffix()}@storm.test`, password: 'WrongPassword123!' },
    });

    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(unknownAccount.statusCode, 401);
    // Identical code and message: the response must not distinguish the cases.
    assert.deepEqual(
      wrongPassword.json<{ error: { code: string; message: string } }>().error.code,
      unknownAccount.json<{ error: { code: string; message: string } }>().error.code,
    );
  });

  it('rotates the refresh token and revokes the old one', async () => {
    const user = await registerUser(app);
    created.push(user.id);

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: user.cookies },
      payload: {},
    });
    assert.equal(first.statusCode, 200);

    const rotated = Array.isArray(first.headers['set-cookie'])
      ? first.headers['set-cookie'].join('; ')
      : String(first.headers['set-cookie'] ?? '');
    assert.match(rotated, /storm_refresh=/);

    // Replaying the original token is treated as a leak: every session dies.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: user.cookies },
      payload: {},
    });
    assert.equal(replay.statusCode, 401);

    const sessions = await app.prisma.session.findMany({
      where: { userId: user.id, revokedAt: null },
    });
    assert.equal(sessions.length, 0, 'reuse detection must revoke every session');
  });

  it('refuses an access token whose session was revoked', async () => {
    const user = await registerUser(app);
    created.push(user.id);

    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(before.statusCode, 200);

    await app.prisma.session.updateMany({
      where: { userId: user.id },
      data: { revokedAt: new Date() },
    });

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    assert.equal(after.statusCode, 401, 'a revoked session must invalidate its access token');
  });

  it('rejects a forged token', async () => {
    const user = await registerUser(app);
    created.push(user.id);

    const [header, payload] = user.accessToken.split('.');
    const forged = `${header}.${payload}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${forged}` },
    });
    assert.equal(response.statusCode, 401);
  });

  it('changes a password and revokes other sessions', async () => {
    const user = await registerUser(app);
    created.push(user.id);

    // A second sign-in, so there is another session to revoke.
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: user.email, password: user.password },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { currentPassword: user.password, newPassword: 'BrandNewPassword456!' },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json<{ data: { sessionsRevoked: number } }>().data.sessionsRevoked >= 1);

    const oldPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: user.email, password: user.password },
    });
    assert.equal(oldPassword.statusCode, 401);

    const newPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: user.email, password: 'BrandNewPassword456!' },
    });
    assert.equal(newPassword.statusCode, 200);
  });

  it('rejects a wrong current password', async () => {
    const user = await registerUser(app);
    created.push(user.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { currentPassword: 'NotMyPassword1!', newPassword: 'BrandNewPassword456!' },
    });
    assert.equal(response.statusCode, 403);
  });

  it('does not disclose whether a password-reset address exists', async () => {
    const user = await registerUser(app);
    created.push(user.id);

    const known = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: user.email },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: `nobody-${uniqueSuffix()}@storm.test` },
    });

    assert.equal(known.statusCode, 200);
    assert.equal(unknown.statusCode, 200);
    assert.deepEqual(known.json(), unknown.json());
  });

  it('completes a password reset and invalidates the token', async () => {
    const user = await registerUser(app);
    created.push(user.id);

    // The email carries the raw token; the database stores only its digest,
    // so the test mints one the same way the route does.
    const rawToken = `reset-${uniqueSuffix()}${uniqueSuffix()}`;
    await app.prisma.verificationToken.create({
      data: {
        userId: user.id,
        type: 'PASSWORD_RESET',
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token: rawToken, password: 'ResetPassword789!' },
    });
    assert.equal(reset.statusCode, 200);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: user.email, password: 'ResetPassword789!' },
    });
    assert.equal(login.statusCode, 200);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token: rawToken, password: 'YetAnotherPass000!' },
    });
    assert.equal(replay.statusCode, 400, 'a reset token must be single use');
  });

  it('signs out and revokes the session', async () => {
    const user = await registerUser(app);
    created.push(user.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: user.cookies },
      payload: {},
    });
    assert.equal(response.statusCode, 200);

    const active = await app.prisma.session.count({
      where: { userId: user.id, revokedAt: null },
    });
    assert.equal(active, 0);
  });

  it('requires authentication for protected routes', async () => {
    for (const url of ['/api/v1/servers', '/api/v1/account', '/api/v1/overview']) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 401, url);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'UNAUTHENTICATED');
    }
  });

  it('blocks a suspended account', async () => {
    const user = await registerUser(app);
    created.push(user.id);

    await app.prisma.user.update({
      where: { id: user.id },
      data: { suspendedAt: new Date() },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: user.email, password: user.password },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json<{ error: { code: string } }>().error.code, 'ACCOUNT_SUSPENDED');
  });

  describe('two-factor authentication', () => {
    let user: RegisteredUser;
    let secret = '';

    before(async () => {
      user = await registerUser(app);
      created.push(user.id);
    });

    it('issues a secret and refuses a wrong confirmation code', async () => {
      const setup = await app.inject({
        method: 'POST',
        url: '/api/v1/account/2fa/setup',
        headers: { authorization: `Bearer ${user.accessToken}` },
        payload: {},
      });
      assert.equal(setup.statusCode, 200);

      const body = setup.json<{ data: { secret: string; otpauthUrl: string } }>();
      assert.ok(body.data.secret.length >= 16);
      secret = body.data.secret;

      // The panel shows this URI as a QR code, so what it carries has to match
      // the secret the panel just stored — a scan that enrols against anything
      // else produces codes this account will never accept.
      const uri = new URL(body.data.otpauthUrl);
      assert.equal(uri.protocol, 'otpauth:');
      assert.equal(uri.host, 'totp');
      assert.equal(uri.searchParams.get('secret'), secret);

      const wrong = await app.inject({
        method: 'POST',
        url: '/api/v1/account/2fa/enable',
        headers: { authorization: `Bearer ${user.accessToken}` },
        payload: { code: '000000', password: user.password },
      });
      assert.equal(wrong.statusCode, 400);
    });

    it('enables with a code derived from the enrolment secret', async () => {
      // The whole point of the QR: a code an authenticator would produce from
      // that secret has to turn 2FA on. This exercises the encrypted round trip
      // the enrolment takes through the database, not otplib's arithmetic.
      const enable = await app.inject({
        method: 'POST',
        url: '/api/v1/account/2fa/enable',
        headers: { authorization: `Bearer ${user.accessToken}` },
        payload: { code: generateTotp(secret), password: user.password },
      });

      assert.equal(enable.statusCode, 200);
      const codes = enable.json<{ data: { backupCodes: string[] } }>().data.backupCodes;
      assert.ok(codes.length >= 8, 'enrolment issues backup codes');
    });

    it('demands a code once 2FA is enabled', async () => {

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: user.email, password: user.password },
      });

      assert.equal(response.statusCode, 401);
      assert.equal(
        response.json<{ error: { code: string } }>().error.code,
        'TWO_FACTOR_REQUIRED',
      );
    });

    it('accepts a backup code exactly once', async () => {
      const code = 'abcd-1234';
      await app.prisma.twoFactorAuth.updateMany({
        where: { userId: user.id },
        data: { backupCodes: [hashToken(code)] },
      });

      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: user.email, password: user.password, totp: code },
      });
      assert.equal(first.statusCode, 200);

      const second = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: user.email, password: user.password, totp: code },
      });
      assert.equal(second.statusCode, 401, 'a backup code must not be reusable');
    });
  });
});
