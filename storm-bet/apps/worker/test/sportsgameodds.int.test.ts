import { randomUUID } from 'node:crypto';
import { BetPlacementService, openWallet, SettlementService } from '@storm-bet/betting-engine';
import { createPrismaClient, withTransaction } from '@storm-bet/database';
import { OddsSyncService, SportsGameOddsProvider } from '@storm-bet/odds-engine';
import { createRedis } from '@storm-bet/redis';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeSgo, T0 } from '../../../packages/odds-engine/test/sportsgameodds.fixtures';

const db = createPrismaClient();
const redis = createRedis(process.env.REDIS_URL!);
afterAll(async () => {
  await db.$disconnect();
  await redis.quit();
});

const MINUTE = 60_000;
const limits = {
  minStake: 10,
  maxStake: 1_000_000,
  maxPayout: 25_000_000,
  maxSelections: 20,
  maxTotalOdds: 10_000,
  acceptHigherMaxPct: 10,
};

describe('SportsGameOdds → sync → settlement', () => {
  it('imports v2 events, takes bets and settles them from the official result', async () => {
    let now = T0;
    const api = fakeSgo();
    const provider = new SportsGameOddsProvider({
      apiKey: 'test-key-1234567890',
      baseUrl: 'https://api.test/v2',
      leagues: ['BUNDESLIGA'],
      bookmakers: [],
      horizonHours: 48,
      oddsTtlMs: 30 * MINUTE,
      liveTtlMs: 2 * MINUTE,
      minRemainingObjects: 50,
      liveBetting: false,
      liveMaxAgeMs: MINUTE,
      fetch: api.fetchImpl,
      now: () => now,
    });
    // A unique provider key per run: the shared test database is never reset.
    const key = `sportsgameodds-test-${randomUUID().slice(0, 8)}`;
    Object.defineProperty(provider, 'key', { value: key });

    const sync = new OddsSyncService(db, redis, provider, {
      horizonHours: 48,
      lookbackHours: 6,
      now: () => now,
    });
    await sync.syncCatalog();

    const events = await db.event.findMany({
      where: { provider: key },
      include: { markets: { include: { selections: true } } },
    });
    const byId = new Map(events.map((e) => [e.externalId, e]));
    expect(byId.get('sgo-live')!.status).toBe('LIVE');
    expect(byId.get('sgo-cancelled')!.status).toBe('CANCELLED');
    expect(byId.get('sgo-no-margin')!.markets).toHaveLength(0);

    const upcoming = byId.get('sgo-upcoming')!;
    const pick = (type: string, outcome: string) => {
      const market = upcoming.markets.find((m) => m.type === type);
      expect(market?.status, type).toBe('OPEN');
      return market!.selections.find((s) => s.outcome === outcome)!;
    };
    const home = pick('MATCH_RESULT', 'HOME');
    const handicap = pick('ASIAN_HANDICAP', 'HOME');
    const under = pick('TOTAL_GOALS', 'UNDER');
    expect([home, handicap, under].map((s) => Number(s.odds))).toEqual([1.625, 1.926, 2.12]);

    const user = await db.user.create({
      data: { email: `sgo-${randomUUID()}@test.local`, displayName: 'SGO', passwordHash: 'x' },
    });
    await withTransaction(db, (tx) => openWallet(tx, user.id, 10_000n));
    const placement = new BetPlacementService({
      db,
      redis,
      limits,
      requireEmailVerification: false,
      now: () => new Date(now),
    });
    const betIds: string[] = [];
    for (const s of [home, handicap, under]) {
      const placed = await placement.place(user.id, {
        idempotencyKey: randomUUID(),
        mode: 'COMBO',
        stake: 1_000,
        oddsChangePolicy: 'REJECT',
        selections: [{ selectionId: s.id, odds: Number(s.odds) }],
      });
      betIds.push(placed.bets[0]!.id);
    }

    // The game is played and the result finalized: 3:1 in regular time.
    const row = api.data.find((e) => e.eventID === 'sgo-upcoming') as Record<string, unknown> & {
      status: Record<string, unknown>;
      teams: { home: Record<string, unknown>; away: Record<string, unknown> };
    };
    Object.assign(row.status, {
      started: true,
      ended: true,
      completed: true,
      finalized: true,
      periods: { started: ['1h', '2h'], ended: ['1h', '2h'] },
    });
    row.teams.home.score = 3;
    row.teams.away.score = 1;
    row.results = {
      game: { home: { points: 3 }, away: { points: 1 } },
      reg: { home: { points: 3 }, away: { points: 1 } },
    };
    now = T0 + 240 * MINUTE;
    await sync.syncLive();

    const finished = await db.event.findUniqueOrThrow({ where: { id: upcoming.id } });
    expect(finished).toMatchObject({ status: 'FINISHED', homeScore: 3, awayScore: 1 });
    expect(finished.resultConfirmedAt).not.toBeNull();

    const settlement = new SettlementService({ db, redis, now: () => new Date(now) });
    expect(await settlement.settleEvent(upcoming.id)).toMatchObject({
      completed: true,
      settledBets: 3,
    });
    const bets = new Map(
      (await db.bet.findMany({ where: { id: { in: betIds } } })).map((b) => [b.id, b]),
    );
    expect(bets.get(betIds[0]!)).toMatchObject({ status: 'WON', payout: 1_625n });
    expect(bets.get(betIds[1]!)).toMatchObject({ status: 'WON', payout: 1_926n });
    expect(bets.get(betIds[2]!)).toMatchObject({ status: 'LOST', payout: 0n });
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({
      balance: 10_000n - 3_000n + 1_625n + 1_926n,
      reserved: 0n,
    });
  });
});
