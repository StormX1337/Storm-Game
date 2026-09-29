import { randomUUID } from 'node:crypto';
import { BetPlacementService, openWallet, SettlementService } from '@storm-bet/betting-engine';
import { createPrismaClient, withTransaction } from '@storm-bet/database';
import { OddsSyncService, TheOddsApiProvider } from '@storm-bet/odds-engine';
import { createRedis } from '@storm-bet/redis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BUNDESLIGA_SCORES,
  fakeApi,
  T0,
} from '../../../packages/odds-engine/test/the-odds-api.fixtures';

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

describe('The Odds API → sync → settlement', () => {
  it('imports real-format fixtures, takes bets and settles them from the scores feed', async () => {
    let now = T0;
    const clock = () => now;
    const scores: unknown[] = [...BUNDESLIGA_SCORES];
    const api = fakeApi({ scores });
    const provider = new TheOddsApiProvider({
      apiKey: 'test-key-1234567890',
      baseUrl: 'https://api.test/v4',
      sports: ['soccer_germany_bundesliga'],
      regions: 'eu',
      bookmakers: ['pinnacle'],
      oddsTtlMs: 10 * MINUTE,
      scoresTtlMs: 5 * MINUTE,
      minRemainingCredits: 25,
      liveBetting: false,
      liveMaxAgeMs: MINUTE,
      fetch: api.fetchImpl,
      now: clock,
    });
    // A unique provider key per run: the shared test database is never reset.
    const key = `theoddsapi-test-${randomUUID().slice(0, 8)}`;
    Object.defineProperty(provider, 'key', { value: key });

    const sync = new OddsSyncService(db, redis, provider, {
      horizonHours: 48,
      lookbackHours: 6,
      now: clock,
    });
    await sync.syncCatalog();

    const events = await db.event.findMany({
      where: { provider: key },
      include: { markets: { include: { selections: true } } },
    });
    const byId = new Map(events.map((e) => [e.externalId, e]));

    // Finished game from the scores feed: result confirmed, nothing bettable.
    expect(byId.get('bl-finished')).toMatchObject({
      status: 'FINISHED',
      homeScore: 2,
      awayScore: 2,
    });
    expect(byId.get('bl-finished')!.resultConfirmedAt).not.toBeNull();
    // Running game: live betting is off by default, so its markets are suspended.
    expect(byId.get('bl-live')!.status).toBe('LIVE');
    expect(byId.get('bl-live')!.markets.every((m) => m.status === 'SUSPENDED')).toBe(true);
    // Quarter lines are not offered.
    expect(byId.get('bl-quarter')!.markets.map((m) => m.type)).toEqual(['MATCH_RESULT']);

    const upcoming = byId.get('bl-upcoming')!;
    expect(upcoming.status).toBe('SCHEDULED');
    const pick = (type: string, outcome: string) => {
      const market = upcoming.markets.find((m) => m.type === type);
      expect(market?.status, type).toBe('OPEN');
      return market!.selections.find((s) => s.outcome === outcome)!;
    };
    const home = pick('MATCH_RESULT', 'HOME');
    const handicap = pick('ASIAN_HANDICAP', 'HOME');
    const under = pick('TOTAL_GOALS', 'UNDER');
    expect(Number(home.odds)).toBe(1.61);
    expect(Number(handicap.odds)).toBe(1.92);
    expect(Number(under.odds)).toBe(2.12);

    const user = await db.user.create({
      data: {
        email: `odds-api-${randomUUID()}@test.local`,
        displayName: 'Odds API',
        passwordHash: 'x',
      },
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

    // Two hours after kick-off the scores feed reports the final result 3:1.
    scores.push({
      id: 'bl-upcoming',
      sport_key: 'soccer_germany_bundesliga',
      commence_time: new Date(T0 + 120 * MINUTE).toISOString(),
      completed: true,
      home_team: 'Bayern Munich',
      away_team: 'Borussia Dortmund',
      scores: [
        { name: 'Bayern Munich', score: '3' },
        { name: 'Borussia Dortmund', score: '1' },
      ],
      last_update: new Date(T0 + 230 * MINUTE).toISOString(),
    });
    now = T0 + 240 * MINUTE;
    await sync.syncLive();

    const finished = await db.event.findUniqueOrThrow({ where: { id: upcoming.id } });
    expect(finished).toMatchObject({ status: 'FINISHED', homeScore: 3, awayScore: 1 });
    expect(finished.resultConfirmedAt).not.toBeNull();

    const settlement = new SettlementService({ db, redis, now: () => new Date(now) });
    const report = await settlement.settleEvent(upcoming.id);
    expect(report).toMatchObject({ completed: true, settledBets: 3 });

    const bets = await db.bet.findMany({ where: { id: { in: betIds } } });
    const status = new Map(bets.map((b) => [b.id, b]));
    // 1X2 home at 1.61 and handicap −1.5 at 1.92 win; under 3.5 loses.
    expect(status.get(betIds[0]!)).toMatchObject({ status: 'WON', payout: 1_610n });
    expect(status.get(betIds[1]!)).toMatchObject({ status: 'WON', payout: 1_920n });
    expect(status.get(betIds[2]!)).toMatchObject({ status: 'LOST', payout: 0n });
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({
      balance: 10_000n - 3_000n + 1_610n + 1_920n,
      reserved: 0n,
    });
  });
});
