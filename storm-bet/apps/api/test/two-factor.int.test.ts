import { totpCode } from '@storm-bet/security';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, createUser, loginAs, PASSWORD } from './helpers';

let t: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const step = () => Math.floor(Date.now() / 30_000);

describe('two-factor login', () => {
  it('sets up TOTP, then asks for a code at login; recovery codes work once', async () => {
    const user = await createUser(t.db);
    const client = await loginAs(t.app, user.email);

    const wrong = await client.post('/api/account/2fa/setup', { password: 'falsch-falsch' });
    expect(wrong.body.error.code).toBe('VALIDATION_ERROR');
    const setup = await client.post('/api/account/2fa/setup', { password: PASSWORD });
    expect(setup.status).toBe(200);
    expect(setup.body.uri).toMatch(/^otpauth:\/\/totp\//);
    const { secret } = setup.body as { secret: string };
    // The secret is stored sealed, never in the clear.
    const row = await t.db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.totpPendingSecret).not.toContain(secret);

    expect((await client.post('/api/account/2fa/enable', { code: '000000' })).body.error.code).toBe(
      'VALIDATION_ERROR',
    );
    const enabled = await client.post('/api/account/2fa/enable', {
      code: totpCode(secret, step()),
    });
    expect(enabled.status).toBe(200);
    const codes = enabled.body.recoveryCodes as string[];
    expect(codes).toHaveLength(10);
    expect((await client.get('/api/account/2fa')).body).toMatchObject({
      enabled: true,
      recoveryCodesLeft: 10,
    });

    // The password alone opens no session.
    const next = new Client(t.app);
    const first = await next.post('/api/auth/login', { email: user.email, password: PASSWORD });
    expect(first.body).toMatchObject({ twoFactorRequired: true });
    expect(next.hasSession).toBe(false);
    const challenge = first.body.challenge as string;
    const bad = await next.post('/api/auth/login/2fa', { challenge, code: '123456' });
    expect(bad.status).toBe(401);
    const ok = await next.post('/api/auth/login/2fa', {
      challenge,
      code: totpCode(secret, step() + 1),
    });
    expect(ok.status).toBe(200);
    expect(next.hasSession).toBe(true);
    // The challenge is spent.
    expect(
      (await new Client(t.app).post('/api/auth/login/2fa', { challenge, code: codes[0] })).status,
    ).toBe(401);

    // A recovery code instead of the app, once.
    const third = new Client(t.app);
    const c3 = (await third.post('/api/auth/login', { email: user.email, password: PASSWORD })).body
      .challenge as string;
    expect(
      (await third.post('/api/auth/login/2fa', { challenge: c3, code: codes[0] })).status,
    ).toBe(200);
    const fourth = new Client(t.app);
    const c4 = (await fourth.post('/api/auth/login', { email: user.email, password: PASSWORD }))
      .body.challenge as string;
    expect(
      (await fourth.post('/api/auth/login/2fa', { challenge: c4, code: codes[0] })).status,
    ).toBe(401);
    await t.redis.del(`sb:rl:login-failures:${user.email}`).catch(() => undefined);

    // Turning it off needs the password and a code.
    const off = await client.post('/api/account/2fa/disable', {
      password: PASSWORD,
      code: codes[1],
    });
    expect(off.status).toBe(200);
    expect((await client.get('/api/account/2fa')).body).toMatchObject({ enabled: false });
    expect(await t.db.recoveryCode.count({ where: { userId: user.id } })).toBe(0);
    const audit = await t.db.auditLog.findMany({
      where: { targetId: user.id, action: { startsWith: 'auth.2fa' } },
      select: { action: true },
    });
    expect(audit.map((a) => a.action).sort()).toEqual([
      'auth.2fa_disabled',
      'auth.2fa_enabled',
      'auth.2fa_failed',
      'auth.2fa_failed',
    ]);
  });
});
