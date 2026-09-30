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
      leagues: ['BUNDESLIGA', 'NBA'],
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
    const nba = byId.get('nba-1')!;
    const players = new Map(
      (await db.player.findMany({ where: { provider: key } })).map((p) => [p.externalId, p.id]),
    );
    const pick = (
      event: typeof upcoming,
      type: string,
      outcome: string,
      playerExternalId?: string,
    ) => {
      const market = event.markets.find(
        (m) =>
          m.type === type &&
          (!playerExternalId ||
            m.selections.some((s) => s.playerId === players.get(playerExternalId))),
      );
      expect(market?.status, type).toBe('OPEN');
      return market!.selections.find(
        (s) =>
          s.outcome === outcome &&
          (!playerExternalId || s.playerId === players.get(playerExternalId)),
      )!;
    };
    const home = pick(upcoming, 'MATCH_RESULT', 'HOME');
    const handicap = pick(upcoming, 'ASIAN_HANDICAP', 'HOME');
    const under = pick(upcoming, 'TOTAL_GOALS', 'UNDER');
    expect([home, handicap, under].map((s) => Number(s.odds))).toEqual([1.625, 1.926, 2.12]);
    const halfTimeAway = pick(upcoming, 'HALF_TIME_RESULT', 'AWAY');
    const secondHalfOver = pick(upcoming, 'SECOND_HALF_TOTAL_GOALS', 'OVER');
    const kane = pick(upcoming, 'PLAYER_TO_SCORE', 'PLAYER', 'HARRY_KANE_1_BUNDESLIGA');
    const musiala = pick(upcoming, 'PLAYER_TO_SCORE', 'PLAYER', 'JAMAL_MUSIALA_1_BUNDESLIGA');
    const tatumOver = pick(nba, 'PLAYER_POINTS', 'OVER', 'JAYSON_TATUM_1_NBA');
    const firstHalfUnder = pick(nba, 'FIRST_HALF_TOTAL_POINTS', 'UNDER');
    const firstHalfHome = pick(nba, 'FIRST_HALF_WINNER', 'HOME');
    expect(
      [halfTimeAway, secondHalfOver, kane, musiala, tatumOver, firstHalfUnder, firstHalfHome].map(
        (s) => Number(s.odds),
      ),
    ).toEqual([4, 1.909, 1.833, 3.1, 1.87, 1.909, 1.417]);

    const user = await db.user.create({
      data: { email: `sgo-${randomUUID()}@test.local`, displayName: 'SGO', passwordHash: 'x' },
    });
    await withTransaction(db, (tx) => openWallet(tx, user.id, 20_000n));
    const placement = new BetPlacementService({
      db,
      redis,
      limits,
      requireEmailVerification: false,
      now: () => new Date(now),
    });
    const betIds: string[] = [];
    const picks = [
      home,
      handicap,
      under,
      halfTimeAway,
      secondHalfOver,
      kane,
      musiala,
      tatumOver,
      firstHalfUnder,
      firstHalfHome,
    ];
    for (const s of picks) {
      const placed = await placement.place(user.id, {
        idempotencyKey: randomUUID(),
        mode: 'COMBO',
        stake: 1_000,
        oddsChangePolicy: 'REJECT',
        selections: [{ selectionId: s.id, odds: Number(s.odds) }],
      });
      betIds.push(placed.bets[0]!.id);
    }

    // Both games are played and their results finalized.
    type Row = Record<string, unknown> & {
      status: Record<string, unknown>;
      teams: { home: Record<string, unknown>; away: Record<string, unknown> };
    };
    const finish = (id: string, home: number, away: number, results: unknown) => {
      const row = api.data.find((e) => e.eventID === id) as Row;
      Object.assign(row.status, { started: true, ended: true, completed: true, finalized: true });
      row.teams.home.score = home;
      row.teams.away.score = away;
      row.results = results;
    };
    // 3:1 in regular time, 0:1 at half time, 11 corners; Kane scores twice, Musiala not.
    finish('sgo-upcoming', 3, 1, {
      game: {
        home: { points: 3 },
        away: { points: 1 },
        HARRY_KANE_1_BUNDESLIGA: { goals: 2 },
        JAMAL_MUSIALA_1_BUNDESLIGA: { goals: 0 },
        SERHOU_GUIRASSY_1_BUNDESLIGA: { goals: 1 },
      },
      reg: { home: { points: 3, cornerKicks: 6 }, away: { points: 1, cornerKicks: 5 } },
      '1h': { home: { points: 0 }, away: { points: 1 } },
      '2h': { home: { points: 3 }, away: { points: 0 } },
    });
    // 110:104, first half 50:55; Tatum scores 31.
    finish('nba-1', 110, 104, {
      game: {
        home: { points: 110 },
        away: { points: 104 },
        JAYSON_TATUM_1_NBA: { points: 31, rebounds: 7, assists: 4, threePointersMade: 5 },
        JIMMY_BUTLER_1_NBA: { points: 20, rebounds: 5, assists: 6 },
      },
      '1h': { home: { points: 50 }, away: { points: 55 } },
    });
    now = T0 + 15 * 60 * MINUTE;
    await sync.syncLive();

    const finished = await db.event.findUniqueOrThrow({ where: { id: upcoming.id } });
    expect(finished).toMatchObject({ status: 'FINISHED', homeScore: 3, awayScore: 1 });
    expect(finished.resultConfirmedAt).not.toBeNull();
    // Stat lines carry internal player ids.
    const stats = finished.statistics as { players: { playerId: string }[] };
    expect(stats.players.map((p) => p.playerId)).toContain(players.get('HARRY_KANE_1_BUNDESLIGA'));

    const settlement = new SettlementService({ db, redis, now: () => new Date(now) });
    expect(await settlement.settleEvent(upcoming.id)).toMatchObject({
      completed: true,
      settledBets: 7,
    });
    expect(await settlement.settleEvent(nba.id)).toMatchObject({
      completed: true,
      settledBets: 3,
    });
    const bets = await db.bet.findMany({ where: { id: { in: betIds } } });
    const byBet = new Map(bets.map((b) => [b.id, b]));
    expect(betIds.map((id) => [byBet.get(id)!.status, byBet.get(id)!.payout])).toEqual([
      ['WON', 1_625n], // 1X2 home
      ['WON', 1_926n], // handicap -1.5
      ['LOST', 0n], // under 3.5
      ['WON', 4_000n], // half time: away
      ['WON', 1_909n], // second half over 1.5 (3:0)
      ['WON', 1_833n], // Kane scores
      ['LOST', 0n], // Musiala does not
      ['WON', 1_870n], // Tatum over 27.5 points
      ['WON', 1_909n], // first half under 108.5 (105)
      ['LOST', 0n], // first half home (50:55)
    ]);
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({
      balance: 20_000n - 10_000n + 1_625n + 1_926n + 4_000n + 1_909n + 1_833n + 1_870n + 1_909n,
      reserved: 0n,
    });
  });
});
