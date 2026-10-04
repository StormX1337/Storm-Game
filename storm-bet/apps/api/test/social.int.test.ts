import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { periodStart } from '../src/services/leaderboard';
import { Client, createTestApp, createUser, loginAs } from './helpers';

let t: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

/** A football match with a 1X2 market open for betting. */
async function openMatch() {
  const sport = await t.db.sport.upsert({
    where: { key: 'football' },
    create: { key: 'football', name: 'Fußball' },
    update: {},
  });
  const tag = randomUUID().slice(0, 8);
  const league = await t.db.league.create({
    data: { sportId: sport.id, provider: 'test', externalId: `soc-${tag}`, name: 'Sozialliga' },
  });
  const [home, away] = await Promise.all(
    ['Ost', 'West'].map((n) =>
      t.db.team.create({
        data: {
          sportId: sport.id,
          provider: 'test',
          externalId: `${n}-${tag}`,
          name: `${n} ${tag}`,
          shortName: n,
        },
      }),
    ),
  );
  const event = await t.db.event.create({
    data: {
      sportId: sport.id,
      leagueId: league.id,
      homeTeamId: home!.id,
      awayTeamId: away!.id,
      provider: 'test',
      externalId: `soc-${tag}`,
      startTime: new Date(Date.now() + 3_600_000),
      status: 'SCHEDULED',
    },
  });
  const market = await t.db.market.create({
    data: {
      eventId: event.id,
      key: 'MATCH_RESULT',
      type: 'MATCH_RESULT',
      name: 'Ergebnis (1X2)',
      selections: {
        create: [
          { key: 'HOME', name: home!.name, outcome: 'HOME', odds: 2.1 },
          { key: 'DRAW', name: 'Unentschieden', outcome: 'DRAW', odds: 3.3 },
          { key: 'AWAY', name: away!.name, outcome: 'AWAY', odds: 3.4 },
        ],
      },
    },
    include: { selections: true },
  });
  const pick = (outcome: string) => market.selections.find((s) => s.outcome === outcome)!;
  return { event, home: pick('HOME'), draw: pick('DRAW'), away: pick('AWAY') };
}

function single(selectionId: string, odds: number, stake: number) {
  return {
    idempotencyKey: randomUUID(),
    mode: 'SINGLES' as const,
    oddsChangePolicy: 'REJECT' as const,
    selections: [{ selectionId, odds, stake }],
  };
}

async function finish(eventId: string, home: number, away: number) {
  await t.db.event.update({
    where: { id: eventId },
    data: {
      status: 'FINISHED',
      homeScore: home,
      awayScore: away,
      resultConfirmedAt: new Date(),
      statistics: {
        sport: 'football',
        goals: { home, away },
        corners: { home: 4, away: 4 },
        yellowCards: { home: 1, away: 1 },
        redCards: { home: 0, away: 0 },
        shotsOnTarget: { home: 5, away: 5 },
        possession: { home: 50, away: 50 },
        goalEvents: [],
      },
    },
  });
  const report = await t.ctx.settlement.settleEvent(eventId);
  expect(report.settledBets).toBeGreaterThan(0);
}

describe('leaderboard periods', () => {
  it('starts weeks on Monday and months on the 1st, Berlin time', () => {
    // Sunday 2026-10-04 12:00 UTC → week from Monday 2026-09-28 00:00 Berlin (UTC+2).
    const sunday = new Date('2026-10-04T12:00:00Z');
    expect(periodStart('week', sunday).toISOString()).toBe('2026-09-27T22:00:00.000Z');
    expect(periodStart('month', sunday).toISOString()).toBe('2026-09-30T22:00:00.000Z');
    // Monday 00:30 Berlin is still Sunday in UTC.
    const monday = new Date('2026-10-04T22:30:00Z');
    expect(periodStart('week', monday).toISOString()).toBe('2026-10-04T22:00:00.000Z');
    // Winter time (UTC+1).
    expect(periodStart('month', new Date('2026-12-10T10:00:00Z')).toISOString()).toBe(
      '2026-11-30T23:00:00.000Z',
    );
  });
});

describe('leaderboard', () => {
  it('ranks players who opted in by profit; others only see their own numbers', async () => {
    const winner = await createUser(t.db);
    const loser = await createUser(t.db);
    const hidden = await createUser(t.db);
    const match = await openMatch();
    await t.ctx.placement.place(winner.id, single(match.home.id, 2.1, 500));
    await t.ctx.placement.place(loser.id, single(match.away.id, 3.4, 300));
    await t.ctx.placement.place(hidden.id, single(match.draw.id, 3.3, 200));
    await finish(match.event.id, 2, 0);

    const w = await loginAs(t.app, winner.email);
    const l = await loginAs(t.app, loser.email);
    const h = await loginAs(t.app, hidden.email);
    expect((await w.put('/api/account/leaderboard', { optIn: true })).body).toEqual({
      optIn: true,
    });
    await l.put('/api/account/leaderboard', { optIn: true });

    const board = (await w.get('/api/leaderboard?period=week')).body;
    const ids = board.entries.map((e: { userId: string }) => e.userId);
    expect(ids).toContain(winner.id);
    expect(ids).toContain(loser.id);
    expect(ids).not.toContain(hidden.id);
    expect(ids.indexOf(winner.id)).toBeLessThan(ids.indexOf(loser.id));
    expect(board.me).toMatchObject({
      optIn: true,
      settled: 1,
      won: 1,
      lost: 0,
      profit: 550,
      hitRate: 1,
    });
    expect(board.me.rank).toBe(ids.indexOf(winner.id) + 1);
    const entry = board.entries.find((e: { userId: string }) => e.userId === winner.id);
    expect(entry).toMatchObject({ me: true, profit: 550, won: 1 });

    // Not taking part: own numbers, no rank, not listed.
    const own = (await h.get('/api/leaderboard')).body.me;
    expect(own).toMatchObject({ optIn: false, rank: null, lost: 1, profit: -200, hitRate: 0 });

    // One decided bet is not enough for the hit-rate ranking.
    const byRate = (await w.get('/api/leaderboard?by=hitrate')).body;
    expect(byRate.minDecided).toBe(5);
    expect(byRate.me.rank).toBeNull();
    expect(byRate.entries.map((e: { userId: string }) => e.userId)).not.toContain(winner.id);

    // Guests see the list without personal numbers.
    const guest = (await new Client(t.app).get('/api/leaderboard?period=month')).body;
    expect(guest.me).toBeNull();
    expect(guest.entries.map((e: { userId: string }) => e.userId)).toContain(winner.id);

    // Leaving takes the player off the list at once.
    await w.put('/api/account/leaderboard', { optIn: false });
    await l.put('/api/account/leaderboard', { optIn: false });
    const after = (await w.get('/api/leaderboard')).body;
    expect(after.entries.map((e: { userId: string }) => e.userId)).not.toContain(winner.id);
    expect(after.me).toMatchObject({ optIn: false, rank: null, profit: 550 });
  });
});

describe('saved bet slips', () => {
  it('keeps up to 20 slips per player, private to their owner', async () => {
    const owner = await createUser(t.db);
    const other = await createUser(t.db);
    const match = await openMatch();
    const mine = await loginAs(t.app, owner.email);
    const theirs = await loginAs(t.app, other.email);

    const created = await mine.post('/api/slips/saved', {
      name: '  Samstag  ',
      selectionIds: [match.home.id, match.draw.id],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Samstag',
      selectionIds: [match.home.id, match.draw.id],
    });

    expect(
      (
        await mine.post('/api/slips/saved', {
          name: 'x',
          selectionIds: [match.home.id, match.home.id],
        })
      ).status,
    ).toBe(400);
    expect((await mine.post('/api/slips/saved', { name: 'x', selectionIds: [] })).status).toBe(400);

    expect((await theirs.get('/api/slips/saved')).body.slips).toEqual([]);
    expect((await theirs.request('DELETE', `/api/slips/saved/${created.body.id}`)).status).toBe(
      404,
    );

    for (let i = 1; i < 20; i += 1)
      await mine.post('/api/slips/saved', { name: `Schein ${i}`, selectionIds: [match.away.id] });
    const full = await mine.post('/api/slips/saved', {
      name: 'zu viel',
      selectionIds: [match.away.id],
    });
    expect(full.status).toBe(409);
    expect((await mine.get('/api/slips/saved')).body.slips).toHaveLength(20);

    expect((await mine.request('DELETE', `/api/slips/saved/${created.body.id}`)).body).toEqual({
      deleted: true,
    });
    const left = (await mine.get('/api/slips/saved')).body.slips;
    expect(left).toHaveLength(19);
    expect(left[0].name).toBe('Schein 19');
  });
});

describe('feed likes and follows', () => {
  it('likes other players’ tips and filters the feed to followed players', async () => {
    const author = await createUser(t.db);
    const reader = await createUser(t.db);
    const match = await openMatch();
    const placed = await t.ctx.placement.place(author.id, single(match.home.id, 2.1, 500));
    const betId = placed.bets[0]!.id;
    const a = await loginAs(t.app, author.email);
    const r = await loginAs(t.app, reader.email);
    await a.post(`/api/bets/${betId}/share`);
    const tip = (await r.get('/api/feed')).body.items.find(
      (i: { bet: { id: string } }) => i.bet.id === betId,
    );
    expect(tip).toMatchObject({ authorId: author.id, following: false, likes: 0, liked: false });

    expect((await a.post(`/api/feed/${tip.id}/like`)).status).toBe(400);
    expect((await r.post(`/api/feed/${tip.id}/like`)).body).toEqual({ liked: true, likes: 1 });
    expect((await r.post(`/api/feed/${tip.id}/like`)).body).toEqual({ liked: true, likes: 1 });
    expect((await r.post(`/api/feed/${randomUUID()}/like`)).status).toBe(404);

    expect((await r.post(`/api/users/${reader.id}/follow`)).status).toBe(400);
    expect((await r.post(`/api/users/${randomUUID()}/follow`)).status).toBe(404);
    const followedIds = async () =>
      (await r.get('/api/feed?filter=following')).body.items.map(
        (i: { bet: { id: string } }) => i.bet.id,
      );
    expect(await followedIds()).not.toContain(betId);
    expect((await r.post(`/api/users/${author.id}/follow`)).body).toEqual({ following: true });
    expect(await followedIds()).toEqual([betId]);
    const seen = (await r.get('/api/feed?filter=following')).body.items[0];
    expect(seen).toMatchObject({ following: true, likes: 1, liked: true });
    // The author sees the like count, not who liked.
    const own = (await a.get('/api/feed')).body.items.find(
      (i: { bet: { id: string } }) => i.bet.id === betId,
    );
    expect(own).toMatchObject({ own: true, likes: 1, liked: false });

    expect((await r.request('DELETE', `/api/feed/${tip.id}/like`)).body).toEqual({
      liked: false,
      likes: 0,
    });
    await r.request('DELETE', `/api/users/${author.id}/follow`);
    expect(await followedIds()).not.toContain(betId);
  });
});
