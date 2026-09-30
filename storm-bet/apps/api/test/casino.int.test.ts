import { randomUUID } from 'node:crypto';
import { CasinoService, MockCasinoProvider, syncCasinoCatalog } from '@storm-bet/casino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, createUser, loginAs } from './helpers';

let t: Awaited<ReturnType<typeof createTestApp>>;
let games: Record<string, string>;
beforeAll(async () => {
  t = await createTestApp();
  await syncCasinoCatalog(t.db, new MockCasinoProvider());
  const rows = await t.db.casinoGame.findMany({ select: { id: true, slug: true } });
  games = Object.fromEntries(rows.map((g) => [g.slug, g.id]));
});
afterAll(async () => {
  await t.close();
});

async function player(balance = 100_000n) {
  const user = await createUser(t.db, 'USER', balance);
  return { user, client: await loginAs(t.app, user.email) };
}

async function ledger(userId: string) {
  return t.db.transaction.findMany({
    where: { userId, type: { in: ['CASINO_BET', 'CASINO_WIN', 'CASINO_REFUND'] } },
    orderBy: { createdAt: 'asc' },
  });
}

const wallet = (userId: string) => t.db.wallet.findUniqueOrThrow({ where: { userId } });

describe('casino API', () => {
  it('requires a session for every route', async () => {
    const anonymous = new Client(t.app);
    expect((await anonymous.get('/api/casino/games')).status).toBe(401);
    expect(
      (await anonymous.post(`/api/casino/games/${games['storm-surge']}/play`, {})).status,
    ).toBe(401);
  });

  it('lists the lobby with categories and favourites', async () => {
    const { client } = await player();
    const lobby = (await client.get('/api/casino/games')).body;
    expect(lobby.games.length).toBeGreaterThanOrEqual(14);
    expect(lobby.categories.map((c: { key: string }) => c.key)).toEqual(
      expect.arrayContaining([
        'slots',
        'roulette',
        'blackjack',
        'baccarat',
        'table-games',
        'live-casino',
      ]),
    );
    const slots = (await client.get('/api/casino/games?category=slots')).body.games;
    expect(slots.every((g: { type: string }) => g.type === 'SLOT')).toBe(true);
    expect((await client.get('/api/casino/games?search=roul')).body.games.length).toBeGreaterThan(
      0,
    );

    const id = games['aurora-gems'];
    expect((await client.post(`/api/casino/favorites/${id}`)).status).toBe(204);
    expect(
      (await client.get('/api/casino/favorites')).body.map((g: { id: string }) => g.id),
    ).toEqual([id]);
    expect((await client.get(`/api/casino/games/${id}`)).body.isFavorite).toBe(true);
    expect((await client.request('DELETE', `/api/casino/favorites/${id}`)).status).toBe(204);
    expect((await client.get('/api/casino/favorites')).body).toEqual([]);
  });

  it('decides a spin on the server and books stake and win once', async () => {
    const { user, client } = await player(10_000n);
    const gameId = games['storm-surge']!;
    const session = (await client.post(`/api/casino/games/${gameId}/session`)).body;
    expect(session.launch).toEqual({ kind: 'internal' });

    const body = {
      sessionId: session.id,
      idempotencyKey: randomUUID(),
      action: 'spin',
      stake: 100,
    };
    // A client cannot smuggle in an outcome.
    expect(
      (await client.post(`/api/casino/games/${gameId}/play`, { ...body, payout: 5000 })).status,
    ).toBe(400);

    const first = await client.post(`/api/casino/games/${gameId}/play`, body);
    expect(first.status).toBe(201);
    const { round } = first.body;
    expect(round.result.reels).toHaveLength(5);
    expect(round.status).toBe('SETTLED');

    // Same key again: the same round, booked once.
    const again = await client.post(`/api/casino/games/${gameId}/play`, body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, round: { id: round.id } });
    // Same key, different request: rejected.
    expect(
      (await client.post(`/api/casino/games/${gameId}/play`, { ...body, stake: 200 })).status,
    ).toBe(409);

    const entries = await ledger(user.id);
    expect(entries.filter((e) => e.type === 'CASINO_BET').map((e) => e.amount)).toEqual([-100n]);
    expect(entries.filter((e) => e.type === 'CASINO_WIN').map((e) => e.amount)).toEqual(
      round.payout > 0 ? [BigInt(round.payout)] : [],
    );
    expect((await wallet(user.id)).balance).toBe(10_000n - 100n + BigInt(round.payout));

    const history = (await client.get('/api/casino/history')).body;
    expect(history.items[0]).toMatchObject({ id: round.id, gameName: 'Storm Surge', stake: 100 });
  });

  it('pays roulette and baccarat bets and refuses stakes it cannot cover', async () => {
    const { user, client } = await player(1_000n);
    const roulette = games['storm-roulette']!;
    const session = (await client.post(`/api/casino/games/${roulette}/session`)).body;
    const spin = await client.post(`/api/casino/games/${roulette}/play`, {
      sessionId: session.id,
      idempotencyKey: randomUUID(),
      action: 'spin',
      bets: [
        { type: 'red', stake: 100 },
        { type: 'straight', value: 7, stake: 50 },
      ],
    });
    expect(spin.status).toBe(201);
    const { number, color } = spin.body.round.result;
    expect(number).toBeGreaterThanOrEqual(0);
    expect(number).toBeLessThanOrEqual(36);
    const expected = (color === 'red' ? 200 : 0) + (number === 7 ? 1800 : 0);
    expect(spin.body.round.payout).toBe(expected);

    const tooMuch = await client.post(`/api/casino/games/${roulette}/play`, {
      sessionId: session.id,
      idempotencyKey: randomUUID(),
      action: 'spin',
      bets: [{ type: 'black', stake: 50_000 }],
    });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_BALANCE');

    const baccarat = games['baccarat-royale']!;
    const bSession = (await client.post(`/api/casino/games/${baccarat}/session`)).body;
    const deal = await client.post(`/api/casino/games/${baccarat}/play`, {
      sessionId: bSession.id,
      idempotencyKey: randomUUID(),
      action: 'deal',
      sides: [{ side: 'banker', stake: 100 }],
    });
    expect(deal.status).toBe(201);
    const r = deal.body.round.result;
    expect(r.player.length).toBeGreaterThanOrEqual(2);
    expect(deal.body.round.payout).toBe(r.winner === 'banker' ? 195 : r.winner === 'tie' ? 100 : 0);
    const balance = (await wallet(user.id)).balance;
    expect(balance).toBe(
      1_000n - 150n + BigInt(spin.body.round.payout) - 100n + BigInt(deal.body.round.payout),
    );
  });
});

describe('blackjack rounds', () => {
  // (max) => max - 1 leaves the shoe unshuffled: the deal is K, Q, J, 10 of clubs.
  const service = () =>
    new CasinoService({
      db: t.db,
      redis: t.redis,
      providers: [new MockCasinoProvider()],
      rng: (m) => m - 1,
    });

  it('keeps the hand on the server, applies each step once and settles it', async () => {
    const { user } = await player(10_000n);
    const casino = service();
    const gameId = games['blackjack-classic']!;
    const session = await casino.openSession(user.id, gameId);
    const deal = await casino.play(user.id, gameId, {
      sessionId: session.id,
      idempotencyKey: randomUUID(),
      action: 'deal',
      stake: 500,
    });
    expect(deal.round).toMatchObject({ status: 'OPEN', step: 0 });
    expect(deal.round.result).toMatchObject({
      playerTotal: 20,
      dealerTotal: null,
      dealer: [{ rank: 'Q' }, null],
    });
    expect(JSON.stringify(deal)).not.toContain('shoe');

    // A second hand in the same session must wait.
    await expect(
      casino.play(user.id, gameId, {
        sessionId: session.id,
        idempotencyKey: randomUUID(),
        action: 'deal',
        stake: 100,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const stand = await casino.play(user.id, gameId, {
      sessionId: session.id,
      idempotencyKey: randomUUID(),
      action: 'stand',
      roundId: deal.round.id,
      step: 0,
    });
    expect(stand.round).toMatchObject({
      status: 'SETTLED',
      payout: 500,
      result: { outcome: 'push', dealerTotal: 20 },
    });
    // Repeating the step replays; another action on an old step conflicts.
    const replay = await casino.play(user.id, gameId, {
      sessionId: session.id,
      idempotencyKey: randomUUID(),
      action: 'stand',
      roundId: deal.round.id,
      step: 0,
    });
    expect(replay.replayed).toBe(true);
    expect((await ledger(user.id)).map((e) => [e.type, e.amount])).toEqual([
      ['CASINO_BET', -500n],
      ['CASINO_WIN', 500n],
    ]);
    expect((await wallet(user.id)).balance).toBe(10_000n);

    // The database refuses to rewrite a settled round or to pay it twice.
    await expect(
      t.db.casinoRound.update({ where: { id: deal.round.id }, data: { payout: 99_999n } }),
    ).rejects.toThrow();
    const w = await wallet(user.id);
    await expect(
      t.db.transaction.create({
        data: {
          walletId: w.id,
          userId: user.id,
          type: 'CASINO_WIN',
          amount: 500n,
          reservedDelta: 0n,
          balanceAfter: w.balance + 500n,
          reservedAfter: 0n,
          casinoRoundId: deal.round.id,
          description: 'second payout',
        },
      }),
    ).rejects.toThrow();
  });

  it('debits a double and loses both stakes on a bust', async () => {
    const { user } = await player(10_000n);
    const casino = service();
    const gameId = games['blackjack-nova']!;
    const session = await casino.openSession(user.id, gameId);
    const deal = await casino.play(user.id, gameId, {
      sessionId: session.id,
      idempotencyKey: randomUUID(),
      action: 'deal',
      stake: 300,
    });
    const double = await casino.play(user.id, gameId, {
      sessionId: session.id,
      idempotencyKey: randomUUID(),
      action: 'double',
      roundId: deal.round.id,
      step: 0,
    });
    // 20 + 9 of clubs = 29.
    expect(double.round).toMatchObject({
      status: 'SETTLED',
      stake: 600,
      payout: 0,
      result: { outcome: 'bust', doubled: true },
    });
    expect((await ledger(user.id)).map((e) => e.amount)).toEqual([-300n, -300n]);
    expect(double.balance.balance).toBe(9_400);
  });

  it('lets staff refund an unfinished hand, with an audit record', async () => {
    const { user } = await player(10_000n);
    const staff = await createUser(t.db, 'ADMIN');
    const admin = await loginAs(t.app, staff.email);
    const casino = service();
    const gameId = games['blackjack-classic']!;
    const session = await casino.openSession(user.id, gameId);
    const deal = await casino.play(user.id, gameId, {
      sessionId: session.id,
      idempotencyKey: randomUUID(),
      action: 'deal',
      stake: 700,
    });
    const refund = await admin.post(`/api/admin/casino/rounds/${deal.round.id}/refund`, {
      reason: 'Test-Erstattung',
    });
    expect(refund.status).toBe(200);
    expect(refund.body).toMatchObject({ status: 'REFUNDED', payout: 700 });
    expect(
      (await admin.post(`/api/admin/casino/rounds/${deal.round.id}/refund`, { reason: 'nochmal' }))
        .status,
    ).toBe(409);
    expect((await wallet(user.id)).balance).toBe(10_000n);
    const audit = await t.db.auditLog.findFirst({
      where: { action: 'casino.round.refunded', targetId: deal.round.id },
    });
    expect(audit?.actorId).toBe(staff.id);
  });
});

describe('instant games', () => {
  // (max) => max - 1: crash at 1.00, the plinko ball always falls right, mines on tiles 0–2.
  const service = () =>
    new CasinoService({
      db: t.db,
      redis: t.redis,
      providers: [new MockCasinoProvider()],
      rng: (m) => m - 1,
    });

  it('decides crash and plinko on the server', async () => {
    const { user } = await player(10_000n);
    const casino = service();
    const crash = games['storm-crash']!;
    const cs = await casino.openSession(user.id, crash);
    const lost = await casino.play(user.id, crash, {
      sessionId: cs.id,
      idempotencyKey: randomUUID(),
      action: 'play',
      stake: 100,
      target: 2,
    });
    expect(lost.round).toMatchObject({
      status: 'SETTLED',
      payout: 0,
      result: { game: 'CRASH', target: 2, crashPoint: 1, won: false },
    });
    await expect(
      casino.play(user.id, crash, {
        sessionId: cs.id,
        idempotencyKey: randomUUID(),
        action: 'play',
        stake: 100,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const plinko = games['storm-plinko']!;
    const ps = await casino.openSession(user.id, plinko);
    const drop = await casino.play(user.id, plinko, {
      sessionId: ps.id,
      idempotencyKey: randomUUID(),
      action: 'drop',
      stake: 100,
      risk: 'low',
    });
    expect(drop.round).toMatchObject({ status: 'SETTLED', payout: 840 });
    expect((await wallet(user.id)).balance).toBe(10_000n - 200n + 840n);
  });

  it('keeps the mines hidden until the round ends and pays a cash-out once', async () => {
    const { user } = await player(10_000n);
    const casino = service();
    const gameId = games['storm-mines']!;
    const session = await casino.openSession(user.id, gameId);
    const start = await casino.play(user.id, gameId, {
      sessionId: session.id,
      idempotencyKey: randomUUID(),
      action: 'start',
      stake: 100,
      mines: 3,
    });
    expect(start.round).toMatchObject({ status: 'OPEN', result: { minePositions: null } });
    expect(JSON.stringify(start)).not.toContain('"actions"');
    const roundId = start.round.id;
    const reveal = await casino.play(user.id, gameId, {
      sessionId: session.id,
      idempotencyKey: randomUUID(),
      action: 'reveal',
      tile: 10,
      roundId,
      step: 0,
    });
    expect(reveal.round).toMatchObject({ status: 'OPEN', result: { revealed: [10] } });
    await expect(
      casino.play(user.id, gameId, {
        sessionId: session.id,
        idempotencyKey: randomUUID(),
        action: 'reveal',
        tile: 10,
        roundId,
        step: 1,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const cash = await casino.play(user.id, gameId, {
      sessionId: session.id,
      idempotencyKey: randomUUID(),
      action: 'cashout',
      roundId,
      step: 1,
    });
    expect(cash.round).toMatchObject({
      status: 'SETTLED',
      payout: 110,
      result: { outcome: 'cashout', minePositions: [0, 1, 2] },
    });
    const replay = await casino.play(user.id, gameId, {
      sessionId: session.id,
      idempotencyKey: randomUUID(),
      action: 'cashout',
      roundId,
      step: 1,
    });
    expect(replay.replayed).toBe(true);
    expect((await wallet(user.id)).balance).toBe(10_010n);

    const next = await casino.play(user.id, gameId, {
      sessionId: session.id,
      idempotencyKey: randomUUID(),
      action: 'start',
      stake: 100,
      mines: 3,
    });
    const boom = await casino.play(user.id, gameId, {
      sessionId: session.id,
      idempotencyKey: randomUUID(),
      action: 'reveal',
      tile: 1,
      roundId: next.round.id,
      step: 0,
    });
    expect(boom.round).toMatchObject({
      status: 'SETTLED',
      payout: 0,
      result: { outcome: 'mine', hit: 1 },
    });
    expect((await wallet(user.id)).balance).toBe(9_910n);
  });
});

describe('dice, keno, wheel, hi-lo and video poker', () => {
  // (max) => max - 1: roll 99.99, keno draws 1–10, the last wheel segment,
  // an endless run of kings in hi-lo, and an unshuffled poker deck (A–5 of spades).
  const service = () =>
    new CasinoService({
      db: t.db,
      redis: t.redis,
      providers: [new MockCasinoProvider()],
      rng: (m) => m - 1,
    });
  const key = () => randomUUID();

  it('decides the single-shot games on the server', async () => {
    const { user } = await player(10_000n);
    const casino = service();
    const run = async (slug: string, body: Record<string, unknown>) => {
      const gameId = games[slug]!;
      const session = await casino.openSession(user.id, gameId);
      return casino.play(user.id, gameId, {
        sessionId: session.id,
        idempotencyKey: key(),
        stake: 100,
        ...body,
      } as never);
    };
    expect(
      (await run('storm-dice', { action: 'roll', chance: 50, direction: 'under' })).round,
    ).toMatchObject({ payout: 0, result: { roll: 99.99, won: false } });
    expect(
      (await run('storm-dice', { action: 'roll', chance: 50, direction: 'over' })).round,
    ).toMatchObject({ payout: 194, result: { won: true, multiplier: 1.94 } });
    expect((await run('storm-keno', { action: 'play', picks: [1, 2, 3] })).round).toMatchObject({
      payout: 2_500,
      result: { hits: [1, 2, 3] },
    });
    await expect(run('storm-keno', { action: 'play', picks: [1, 1] })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect((await run('storm-wheel', { action: 'spin' })).round).toMatchObject({
      payout: 150,
      result: { segment: 49, multiplier: 1.5 },
    });
  });

  it('plays hi-lo and video poker step by step and never shows what is to come', async () => {
    const { user } = await player(10_000n);
    const casino = service();
    const hilo = games['storm-hilo']!;
    const hs = await casino.openSession(user.id, hilo);
    const start = await casino.play(user.id, hilo, {
      sessionId: hs.id,
      idempotencyKey: key(),
      action: 'start',
      stake: 100,
    });
    expect(start.round.result).toMatchObject({ current: { rank: 'K' } });
    expect(JSON.stringify(start)).not.toContain('queue');
    const step = (action: 'higher' | 'lower' | 'cashout', n: number) =>
      casino.play(user.id, hilo, {
        sessionId: hs.id,
        idempotencyKey: key(),
        action,
        roundId: start.round.id,
        step: n,
      });
    // Lower-or-same than a king cannot lose: refused.
    await expect(step('lower', 0)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect((await step('higher', 0)).round).toMatchObject({
      status: 'OPEN',
      result: { multiplier: 12.61 },
    });
    expect((await step('cashout', 1)).round).toMatchObject({ status: 'SETTLED', payout: 1_261 });
    expect((await step('cashout', 1)).replayed).toBe(true);

    const poker = games['storm-poker']!;
    const ps = await casino.openSession(user.id, poker);
    const deal = await casino.play(user.id, poker, {
      sessionId: ps.id,
      idempotencyKey: key(),
      action: 'deal',
      stake: 100,
    });
    expect(deal.round).toMatchObject({ status: 'OPEN', result: { final: false } });
    expect(JSON.stringify(deal)).not.toContain('deck');
    const drawn = await casino.play(user.id, poker, {
      sessionId: ps.id,
      idempotencyKey: key(),
      action: 'draw',
      holds: [0, 1, 2, 3, 4],
      roundId: deal.round.id,
      step: 0,
    });
    expect(drawn.round).toMatchObject({
      status: 'SETTLED',
      payout: 5_000,
      result: { handName: 'straight_flush', multiplier: 50 },
    });

    // A hand left open is drawn with every card kept when the session closes.
    const open = await casino.play(user.id, poker, {
      sessionId: ps.id,
      idempotencyKey: key(),
      action: 'deal',
      stake: 100,
    });
    await casino.closeSession(ps.id, { userId: user.id }, 'Spieler');
    expect(
      await t.db.casinoRound.findUniqueOrThrow({ where: { id: open.round.id } }),
    ).toMatchObject({ status: 'SETTLED', payout: 5_000n });
    expect((await wallet(user.id)).balance).toBe(
      10_000n - 100n + 1_261n - 100n + 5_000n - 100n + 5_000n,
    );
  });
});

describe('casino admin', () => {
  it('manages games with RBAC and an audit trail', async () => {
    const staff = await createUser(t.db, 'ADMIN');
    const admin = await loginAs(t.app, staff.email);
    const { client } = await player();
    const gameId = games['midnight-orchard']!;

    expect((await client.get('/api/admin/casino/games')).status).toBe(403);
    const support = await loginAs(t.app, (await createUser(t.db, 'SUPPORT')).email);
    expect((await support.get('/api/admin/casino/games')).status).toBe(200);
    expect(
      (
        await support.patch(`/api/admin/casino/games/${gameId}`, {
          status: 'DISABLED',
          reason: 'x-test',
        })
      ).status,
    ).toBe(403);

    try {
      expect(
        (
          await admin.patch(`/api/admin/casino/games/${gameId}`, {
            status: 'MAINTENANCE',
            isFeatured: true,
            reason: 'Wartungstest',
          })
        ).status,
      ).toBe(200);
      const session = await client.post(`/api/casino/games/${gameId}/session`);
      expect(session.status).toBe(503);
      const audit = await t.db.auditLog.findFirst({
        where: { action: 'casino.game.updated', targetId: gameId },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit?.metadata).toMatchObject({
        reason: 'Wartungstest',
        changes: { status: 'MAINTENANCE' },
      });
    } finally {
      await admin.patch(`/api/admin/casino/games/${gameId}`, {
        status: 'ACTIVE',
        isFeatured: false,
        reason: 'Test beendet',
      });
    }
    expect((await client.post(`/api/casino/games/${gameId}/session`)).status).toBe(201);

    const sessions = (await admin.get('/api/admin/casino/sessions?status=OPEN')).body;
    expect(sessions.items.length).toBeGreaterThan(0);
    const close = await admin.post(`/api/admin/casino/sessions/${sessions.items[0].id}/close`, {
      reason: 'Admin-Test',
    });
    expect(close.status).toBe(200);
    expect((await admin.get('/api/admin/casino/providers')).body[0]).toMatchObject({
      key: 'mock',
      isSimulated: true,
    });
  });
});
