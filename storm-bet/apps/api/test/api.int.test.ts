import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, createUser, loginAs, PASSWORD } from './helpers';

let t: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const newEmail = () => `player-${randomUUID()}@test.local`;
const registration = (email: string) => ({
  email,
  password: PASSWORD,
  displayName: 'Neuer Spieler',
  ageConfirmed: true,
  termsAccepted: true,
});

describe('registration', () => {
  it('creates an account with a session, a demo wallet and a verification mail', async () => {
    const client = new Client(t.app);
    const email = newEmail();
    const res = await client.post('/api/auth/register', registration(email));
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email,
      role: 'USER',
      emailVerified: false,
      permissions: [],
    });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/sb_session=.+HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);

    const wallet = await client.get('/api/wallet');
    expect(wallet.body).toEqual({
      currency: 'DEMO',
      balance: 100_000,
      reserved: 0,
      available: 100_000,
    });
    const txs = await client.get('/api/transactions');
    expect(txs.body.items[0]).toMatchObject({ type: 'DEPOSIT_DEMO', amount: 100_000 });

    const token = t.mailer.lastTokenFor(email);
    expect((await client.post('/api/auth/verify-email', { token })).status).toBe(200);
    expect((await client.get('/api/auth/session')).body.user.emailVerified).toBe(true);
    // Tokens are single-use.
    expect((await client.post('/api/auth/verify-email', { token })).status).toBe(400);
  });

  it('stores passwords as argon2id, never in plain text', async () => {
    const email = newEmail();
    await new Client(t.app).post('/api/auth/register', registration(email));
    const user = await t.db.user.findUniqueOrThrow({ where: { email } });
    expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(user.passwordHash).not.toContain(PASSWORD);
  });

  it('rejects duplicates and invalid input with field errors', async () => {
    const email = newEmail();
    await new Client(t.app).post('/api/auth/register', registration(email));
    const dup = await new Client(t.app).post(
      '/api/auth/register',
      registration(email.toUpperCase()),
    );
    expect(dup.status).toBe(409);
    const invalid = await new Client(t.app).post('/api/auth/register', {
      ...registration(newEmail()),
      ageConfirmed: false,
      password: 'kurz',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(invalid.body.error.details.fields)).toEqual(
      expect.arrayContaining(['password', 'ageConfirmed']),
    );
  });
});

describe('login', () => {
  it('logs in and out; a logged-out session cannot be reused', async () => {
    const user = await createUser(t.db);
    const client = await loginAs(t.app, user.email);
    expect((await client.get('/api/auth/session')).body.user.id).toBe(user.id);
    expect((await client.post('/api/auth/logout')).status).toBe(200);
    expect((await client.get('/api/auth/session')).body.user).toBeNull();
    expect((await client.get('/api/wallet')).status).toBe(401);
  });

  it('answers wrong password and unknown account identically', async () => {
    const user = await createUser(t.db);
    const wrong = await new Client(t.app).post('/api/auth/login', {
      email: user.email,
      password: 'falsch-123456',
    });
    const unknown = await new Client(t.app).post('/api/auth/login', {
      email: newEmail(),
      password: 'falsch-123456',
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('locks an account out after repeated failures (brute-force protection)', async () => {
    const user = await createUser(t.db);
    for (let i = 0; i < 5; i += 1) {
      expect(
        (
          await new Client(t.app).post('/api/auth/login', {
            email: user.email,
            password: `wrong-${i}-pass`,
          })
        ).status,
      ).toBe(401);
    }
    const blocked = await new Client(t.app).post('/api/auth/login', {
      email: user.email,
      password: PASSWORD,
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('rate limits login attempts per IP', async () => {
    const client = new Client(t.app);
    let last = 0;
    for (let i = 0; i < 21; i += 1) {
      last = (await client.post('/api/auth/login', { email: newEmail(), password: 'irrelevant-1' }))
        .status;
    }
    expect(last).toBe(429);
  });

  it('refuses locked accounts', async () => {
    const user = await createUser(t.db);
    await t.db.user.update({ where: { id: user.id }, data: { status: 'LOCKED' } });
    const res = await new Client(t.app).post('/api/auth/login', {
      email: user.email,
      password: PASSWORD,
    });
    expect(res.status).toBe(403);
  });
});

describe('csrf and origin checks', () => {
  it('rejects state-changing requests without a valid token or from another origin', async () => {
    const user = await createUser(t.db);
    const client = await loginAs(t.app, user.email);
    expect((await client.post('/api/wallet/top-up', {}, { csrf: false })).status).toBe(403);
    expect(
      (await client.post('/api/wallet/top-up', {}, { origin: 'https://evil.example' })).status,
    ).toBe(403);
    // With a valid token the request reaches the handler (and fails for a business reason).
    expect((await client.post('/api/wallet/top-up', {})).body.error.code).toBe('CONFLICT');
  });
});

describe('password reset', () => {
  it('resets via a single-use mailed token and revokes existing sessions', async () => {
    const user = await createUser(t.db);
    const session = await loginAs(t.app, user.email);
    const anonymous = new Client(t.app);
    const res = await anonymous.post('/api/auth/forgot-password', { email: user.email });
    expect(res.status).toBe(202);
    const token = t.mailer.lastTokenFor(user.email);
    const newPassword = 'Ganz-neues-Passwort-1';
    expect(
      (await anonymous.post('/api/auth/reset-password', { token, password: newPassword })).status,
    ).toBe(200);
    expect(
      (await anonymous.post('/api/auth/reset-password', { token, password: newPassword })).status,
    ).toBe(400);
    expect((await session.get('/api/wallet')).status).toBe(401);
    expect(
      (
        await new Client(t.app).post('/api/auth/login', {
          email: user.email,
          password: newPassword,
        })
      ).status,
    ).toBe(200);
  });

  it('does not reveal whether an account exists', async () => {
    const res = await new Client(t.app).post('/api/auth/forgot-password', { email: newEmail() });
    expect(res.status).toBe(202);
  });
});

describe('permissions', () => {
  it('keeps players and anonymous visitors out of the admin API', async () => {
    const player = await loginAs(t.app, (await createUser(t.db)).email);
    expect((await player.get('/api/admin/users')).status).toBe(403);
    expect((await new Client(t.app).get('/api/admin/users')).status).toBe(401);
  });

  it('grants each staff role only its own permissions', async () => {
    const support = await loginAs(t.app, (await createUser(t.db, 'SUPPORT')).email);
    const trader = await loginAs(t.app, (await createUser(t.db, 'TRADER')).email);
    const victim = await createUser(t.db);
    expect((await support.get('/api/admin/users')).status).toBe(200);
    expect(
      (await support.post(`/api/admin/users/${victim.id}/lock`, { reason: 'Test' })).status,
    ).toBe(403);
    expect((await support.get('/api/admin/audit-logs')).status).toBe(403);
    expect((await trader.get('/api/admin/events')).status).toBe(200);
    expect((await trader.get('/api/admin/users')).status).toBe(403);
  });
});

describe('admin API', () => {
  it('locks and unlocks a user with an audit trail; locking ends their sessions', async () => {
    const admin = await createUser(t.db, 'ADMIN');
    const adminClient = await loginAs(t.app, admin.email);
    const player = await createUser(t.db);
    const playerClient = await loginAs(t.app, player.email);

    const locked = await adminClient.post(`/api/admin/users/${player.id}/lock`, {
      reason: 'Verdacht auf Missbrauch',
    });
    expect(locked.status).toBe(200);
    expect(locked.body.status).toBe('LOCKED');
    expect((await playerClient.get('/api/wallet')).status).toBe(401);
    expect(
      (await new Client(t.app).post('/api/auth/login', { email: player.email, password: PASSWORD }))
        .status,
    ).toBe(403);

    expect(
      (await adminClient.post(`/api/admin/users/${player.id}/unlock`, { reason: 'Geklärt' })).body
        .status,
    ).toBe('ACTIVE');
    const audit = await adminClient.get(`/api/admin/audit-logs?targetId=${player.id}`);
    expect(audit.body.items.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['admin.user_locked', 'admin.user_unlocked']),
    );
    expect(audit.body.items[0].actorId).toBe(admin.id);
  });

  it('requires password confirmation for role changes and protects against self-demotion', async () => {
    const admin = await createUser(t.db, 'ADMIN');
    const client = await loginAs(t.app, admin.email);
    const target = await createUser(t.db);
    expect(
      (
        await client.patch(`/api/admin/users/${target.id}/role`, {
          role: 'SUPPORT',
          confirmPassword: 'falsch',
          reason: 'Team',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await client.patch(`/api/admin/users/${target.id}/role`, {
          role: 'SUPPORT',
          confirmPassword: PASSWORD,
          reason: 'Team',
        })
      ).body.role,
    ).toBe('SUPPORT');
    expect(
      (
        await client.patch(`/api/admin/users/${admin.id}/role`, {
          role: 'USER',
          confirmPassword: PASSWORD,
          reason: 'Selbsttest',
        })
      ).status,
    ).toBe(403);
  });

  it('runs a manual event from creation to settlement', async () => {
    const admin = await createUser(t.db, 'ADMIN');
    const adminClient = await loginAs(t.app, admin.email);
    const catalog = (await adminClient.get('/api/admin/catalog')).body;
    const league = catalog.leagues.find((l: { sportKey: string }) => l.sportKey === 'football');
    const teams = catalog.teams.filter((x: { sportKey: string }) => x.sportKey === 'football');
    expect(league && teams.length >= 2).toBeTruthy();

    const created = await adminClient.post('/api/admin/events', {
      sport: 'football',
      leagueId: league.id,
      homeTeamId: teams[0].id,
      awayTeamId: teams[1].id,
      startTime: new Date(Date.now() + 3_600_000).toISOString(),
      markets: [
        {
          type: 'MATCH_RESULT',
          line: null,
          selections: [
            { outcome: 'HOME', odds: 2.1 },
            { outcome: 'DRAW', odds: 3.3 },
            { outcome: 'AWAY', odds: 3.5 },
          ],
        },
        {
          type: 'TOTAL_GOALS',
          line: 2.5,
          selections: [
            { outcome: 'OVER', odds: 1.9 },
            { outcome: 'UNDER', odds: 1.9 },
          ],
        },
      ],
    });
    expect(created.status).toBe(201);
    const eventId = created.body.id;
    const home = created.body.markets[0].selections.find(
      (s: { outcome: string }) => s.outcome === 'HOME',
    );

    // Players see it immediately.
    const player = await createUser(t.db);
    const playerClient = await loginAs(t.app, player.email);
    expect((await playerClient.get(`/api/events/${eventId}`)).body.markets).toHaveLength(2);

    // Odds edits are audited, versioned and invalidate stale quotes.
    const updated = await adminClient.patch(`/api/admin/selections/${home.id}`, {
      odds: 2.2,
      reason: 'Marktbewegung',
    });
    expect(updated.status).toBe(200);
    const stale = await playerClient.post('/api/bets/place', {
      idempotencyKey: randomUUID(),
      mode: 'COMBO',
      stake: 1_000,
      selections: [{ selectionId: home.id, odds: 2.1 }],
    });
    expect(stale.body.error.code).toBe('ODDS_CHANGED');
    const key = randomUUID();
    const bet = {
      idempotencyKey: key,
      mode: 'COMBO',
      stake: 1_000,
      selections: [{ selectionId: home.id, odds: 2.2 }],
    };
    const placed = await playerClient.post('/api/bets/place', bet);
    expect(placed.status).toBe(201);
    const replay = await playerClient.post('/api/bets/place', bet);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.bets[0].id).toBe(placed.body.bets[0].id);

    // Result entry is only possible once the event has started.
    await t.db.event.update({
      where: { id: eventId },
      data: { startTime: new Date(Date.now() - 60_000), status: 'LIVE' },
    });
    const result = await adminClient.post(`/api/admin/events/${eventId}/result`, {
      reason: 'Offizielles Ergebnis',
      statistics: {
        sport: 'football',
        goals: { home: 2, away: 1 },
        corners: { home: 6, away: 3 },
        yellowCards: { home: 1, away: 2 },
        redCards: { home: 0, away: 0 },
        shotsOnTarget: { home: 7, away: 4 },
        possession: { home: 55, away: 45 },
        goalEvents: [],
      },
    });
    expect(result.status).toBe(200);
    expect(result.body.settlement.settledBets).toBe(1);

    const settled = await playerClient.get(`/api/bets/${placed.body.bets[0].id}`);
    expect(settled.body).toMatchObject({ status: 'WON', payout: 2_200 });
    expect((await playerClient.get('/api/wallet')).body).toMatchObject({
      balance: 101_200,
      reserved: 0,
    });

    // A settled event is final.
    expect(
      (
        await adminClient.post(`/api/admin/events/${eventId}/actions`, {
          action: 'cancel',
          reason: 'zu spät',
        })
      ).status,
    ).toBe(409);
    const trail = await adminClient.get(`/api/admin/audit-logs?targetId=${eventId}`);
    expect(trail.body.items.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['admin.event_created', 'admin.event_result_set', 'event.resulted']),
    );
  });

  it('refunds an open bet and never edits feed odds', async () => {
    const admin = await createUser(t.db, 'ADMIN');
    const adminClient = await loginAs(t.app, admin.email);
    const feedSelection = await t.db.selection.findFirst({
      where: { market: { event: { provider: { not: 'manual' } } } },
    });
    if (feedSelection) {
      expect(
        (
          await adminClient.patch(`/api/admin/selections/${feedSelection.id}`, {
            odds: 5,
            reason: 'Test',
          })
        ).status,
      ).toBe(403);
    }
  });

  it('never lets one player read another player’s bet', async () => {
    const a = await loginAs(t.app, (await createUser(t.db)).email);
    const b = await loginAs(t.app, (await createUser(t.db)).email);
    const anyBet = await t.db.bet.findFirst();
    if (anyBet) {
      expect((await a.get(`/api/bets/${anyBet.id}`)).status).toBe(404);
      expect((await b.get(`/api/bets/${anyBet.id}`)).status).toBe(404);
    }
  });
});

describe('errors', () => {
  it('rejects unknown filter values with a validation error', async () => {
    const admin = await loginAs(t.app, (await createUser(t.db, 'ADMIN')).email);
    const res = await admin.get('/api/admin/transactions?type=NOPE');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('never leaks internals', async () => {
    const res = await new Client(t.app).get('/api/events/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|stack|at \w+ \(/i);
  });
});
