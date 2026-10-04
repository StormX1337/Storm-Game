import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, loginAs } from './helpers';

let t: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

async function openSelection() {
  const sport = await t.db.sport.upsert({
    where: { key: 'football' },
    create: { key: 'football', name: 'Fußball' },
    update: {},
  });
  const tag = randomUUID().slice(0, 8);
  const league = await t.db.league.create({
    data: { sportId: sport.id, provider: 'test', externalId: `feed-${tag}`, name: 'Feedliga' },
  });
  const [home, away] = await Promise.all(
    ['Nord', 'Süd'].map((n) =>
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
      externalId: `feed-${tag}`,
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
  return market.selections.find((s) => s.outcome === 'HOME')!;
}

describe('tip feed', () => {
  it('shows shared bets with picks and odds, never stakes; only the owner can share', async () => {
    const owner = await createUser(t.db);
    const other = await createUser(t.db);
    const selection = await openSelection();
    const placed = await t.ctx.placement.place(owner.id, {
      idempotencyKey: randomUUID(),
      mode: 'SINGLES',
      oddsChangePolicy: 'REJECT',
      selections: [{ selectionId: selection.id, odds: 2.1, stake: 500 }],
    });
    const betId = placed.bets[0]!.id;
    const mine = await loginAs(t.app, owner.email);
    const theirs = await loginAs(t.app, other.email);

    expect((await theirs.post(`/api/bets/${betId}/share`)).status).toBe(404);
    expect((await mine.post(`/api/bets/${betId}/share`)).body).toEqual({ shared: true });
    expect((await mine.get(`/api/bets/${betId}`)).body.shared).toBe(true);

    const feed = await theirs.get('/api/feed?filter=open');
    const item = feed.body.items.find((i: { bet: { id: string } }) => i.bet.id === betId);
    expect(item).toMatchObject({
      author: 'USER Test',
      own: false,
      bet: { status: 'PENDING', totalOdds: 2.1 },
    });
    expect(item.bet.selections[0]).toMatchObject({ selectionId: selection.id, odds: 2.1 });
    const json = JSON.stringify(item);
    for (const secret of ['stake', 'payout', 'potentialReturn', 'reference', 'snapshot'])
      expect(json).not.toContain(secret);

    expect(
      (await theirs.get('/api/feed?filter=won')).body.items.map(
        (i: { bet: { id: string } }) => i.bet.id,
      ),
    ).not.toContain(betId);
    await mine.request('DELETE', `/api/bets/${betId}/share`);
    expect(
      (await theirs.get('/api/feed')).body.items.map((i: { bet: { id: string } }) => i.bet.id),
    ).not.toContain(betId);
  });
});

describe('event search', () => {
  it('finds open events by team name and nothing else', async () => {
    const selection = await openSelection();
    const team = selection.name;
    const client = await loginAs(t.app, (await createUser(t.db)).email);
    const res = await client.get(`/api/events?q=${encodeURIComponent(team.toUpperCase())}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].home.name).toBe(team);
    expect((await client.get('/api/events?q=zz-kein-team-zz')).body.items).toHaveLength(0);
  });
});
