import { describe, expect, it } from 'vitest';
import {
  americanToDecimal,
  ProviderError,
  ProviderRateLimitedError,
  SportsGameOddsProvider,
  type SportsGameOddsOptions,
} from '../src';
import { fakeSgo, T0 } from './sportsgameodds.fixtures';

const MINUTE = 60_000;

function provider(
  overrides: Partial<SportsGameOddsOptions> = {},
  api = fakeSgo(),
  now: () => number = () => T0,
) {
  return {
    api,
    provider: new SportsGameOddsProvider({
      apiKey: 'test-key-1234567890',
      baseUrl: 'https://api.test/v2',
      leagues: ['BUNDESLIGA', 'UEFA_CHAMPIONS_LEAGUE', 'NBA', 'ATP', 'NFL'],
      bookmakers: [],
      horizonHours: 48,
      oddsTtlMs: 30 * MINUTE,
      liveTtlMs: 2 * MINUTE,
      minRemainingObjects: 50,
      liveBetting: false,
      liveMaxAgeMs: MINUTE,
      fetch: api.fetchImpl,
      now,
      ...overrides,
    }),
  };
}

const window = {
  from: new Date(T0 - 6 * 3_600_000).toISOString(),
  to: new Date(T0 + 48 * 3_600_000).toISOString(),
};

const FULL_GAME = new Set([
  'MATCH_RESULT',
  'ASIAN_HANDICAP',
  'TOTAL_GOALS',
  'MATCH_WINNER',
  'POINT_SPREAD',
  'TOTAL_POINTS',
]);
/** Markets the feed quotes itself (derived ones are covered separately). */
const quoted = <T extends { derived?: boolean }>(markets: T[]) => markets.filter((m) => !m.derived);
const fullGame = <T extends { type: string; derived?: boolean }>(markets: T[]) =>
  quoted(markets).filter((m) => FULL_GAME.has(m.type));

const prices = (market: { selections: { outcome: string; odds: number }[] } | undefined) =>
  Object.fromEntries((market?.selections ?? []).map((s) => [s.outcome, s.odds]));

describe('americanToDecimal', () => {
  it('converts American odds exactly to three decimals', () => {
    expect(americanToDecimal('+150')).toBe(2.5);
    expect(americanToDecimal('-110')).toBe(1.909);
    expect(americanToDecimal('-160')).toBe(1.625);
    expect(americanToDecimal('+100')).toBe(2);
    expect(americanToDecimal('-100')).toBe(2);
    expect(americanToDecimal('EVEN')).toBeNull();
    expect(americanToDecimal('+50')).toBeNull();
    expect(americanToDecimal(undefined)).toBeNull();
  });
});

describe('SportsGameOddsProvider', () => {
  it('is real data, authenticates by header and maps only supported leagues', async () => {
    const { provider: p, api } = provider();
    expect(p.isSimulated).toBe(false);
    const leagues = await p.getLeagues();
    // NFL is American football: not a sport this book offers.
    expect(leagues.map((l) => l.externalId)).toEqual([
      'BUNDESLIGA',
      'UEFA_CHAMPIONS_LEAGUE',
      'NBA',
      'ATP',
    ]);
    expect((await p.getSports()).map((s) => s.key).sort()).toEqual([
      'basketball',
      'football',
      'tennis',
    ]);
    expect(api.calls.every((c) => c.apiKey === 'test-key-1234567890')).toBe(true);
    expect(api.calls.every((c) => !c.params.has('apiKey'))).toBe(true);
  });

  it('takes every supported league of the plan with "*"', async () => {
    const { provider: p } = provider({ leagues: ['*'] });
    expect((await p.getLeagues()).map((l) => l.externalId)).toEqual([
      'BUNDESLIGA',
      'UEFA_CHAMPIONS_LEAGUE',
      'NBA',
      'ATP',
    ]);
    const nfl = (await p.availableLeagues()).find((l) => l.id === 'NFL');
    expect(nfl).toMatchObject({ supported: false, active: false });
  });

  it('falls back to the built-in league list when the leagues endpoint fails', async () => {
    const { provider: p } = provider({}, fakeSgo({ leaguesStatus: 503 }));
    expect((await p.getLeagues()).map((l) => [l.externalId, l.sportKey])).toEqual([
      ['BUNDESLIGA', 'football'],
      ['UEFA_CHAMPIONS_LEAGUE', 'football'],
      ['NBA', 'basketball'],
      ['ATP', 'tennis'],
    ]);
  });

  it('maps regular-time 1X2, handicap and total from consensus prices', async () => {
    const { provider: p } = provider();
    const events = await p.getEvents(window);
    const upcoming = events.find((e) => e.externalId === 'sgo-upcoming')!;
    expect(upcoming).toMatchObject({
      status: 'SCHEDULED',
      home: { externalId: 'BAYERN_MUNICH_BUNDESLIGA', name: 'Bayern Munich', shortName: 'BAY' },
      resultFinal: false,
    });
    const markets = fullGame(await p.getMarkets('sgo-upcoming'));
    expect(markets.map((m) => m.key).sort()).toEqual([
      'ASIAN_HANDICAP:-1.5',
      'MATCH_RESULT',
      'TOTAL_GOALS:3.5',
    ]);
    const byType = (t: string) => markets.find((m) => m.type === t);
    // "reg" is preferred over "game" (which would include extra time).
    expect(prices(byType('MATCH_RESULT'))).toEqual({ HOME: 1.625, DRAW: 4.6, AWAY: 5 });
    expect(byType('MATCH_RESULT')!.selections.find((s) => s.outcome === 'DRAW')!.name).toBe(
      'Unentschieden',
    );
    expect(prices(byType('ASIAN_HANDICAP'))).toEqual({ HOME: 1.926, AWAY: 1.893 });
    expect(byType('ASIAN_HANDICAP')!.selections.map((s) => s.name)).toEqual([
      'Bayern Munich -1.5',
      'Borussia Dortmund +1.5',
    ]);
    // The game total, not the team total at 2.5.
    expect(prices(byType('TOTAL_GOALS'))).toEqual({ OVER: 1.725, UNDER: 2.12 });
    expect(markets.every((m) => m.status === 'OPEN')).toBe(true);
    expect(markets.flatMap((m) => m.selections).every((s) => !s.playerExternalId)).toBe(true);
  });

  it('uses one preferred bookmaker for all markets when configured', async () => {
    const { provider: p } = provider({ bookmakers: ['bet365', 'pinnacle'] });
    await p.getEvents(window);
    const markets = await p.getMarkets('sgo-upcoming');
    expect(prices(markets.find((m) => m.type === 'MATCH_RESULT'))).toEqual({
      HOME: 1.645,
      DRAW: 4.55,
      AWAY: 5.02,
    });
    expect(prices(markets.find((m) => m.type === 'ASIAN_HANDICAP'))).toEqual({
      HOME: 1.909,
      AWAY: 1.962,
    });
  });

  it('adds model-priced football markets before kick-off, never replacing quoted ones', async () => {
    const { provider: p } = provider();
    await p.getEvents(window);
    const markets = await p.getMarkets('sgo-upcoming');
    const derived = markets.filter((m) => m.derived);
    const keys = derived.map((m) => m.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'DOUBLE_CHANCE',
        'DRAW_NO_BET',
        'BOTH_TEAMS_TO_SCORE',
        'TOTAL_GOALS:1.5',
        'TOTAL_GOALS:4.5',
        'ASIAN_HANDICAP:-0.5',
      ]),
    );
    // One market per key: the feed's own lines stay the feed's.
    expect(new Set(markets.map((m) => m.key)).size).toBe(markets.length);
    for (const market of derived) {
      expect(market.status).toBe('OPEN');
      const book = market.selections.reduce((sum, s) => sum + 1 / s.odds, 0);
      expect(book).toBeGreaterThan(market.type === 'DOUBLE_CHANCE' ? 2 : 1);
    }
    // The feed's own 3.5 line stays; over 1.5 is shorter than over 4.5.
    expect(markets.find((m) => m.key === 'TOTAL_GOALS:3.5')!.derived).toBeUndefined();
    const over = (line: number) =>
      markets
        .find((m) => m.key === `TOTAL_GOALS:${line}`)!
        .selections.find((s) => s.outcome === 'OVER')!.odds;
    expect(over(1.5)).toBeLessThan(over(4.5));
    // Nothing derived for running games.
    expect((await p.getMarkets('sgo-live')).some((m) => m.derived)).toBe(false);
  });

  it('settles a completed game after a short delay, without waiting for "finalized"', async () => {
    let now = T0;
    const { provider: p } = provider({ settleAfterMs: 5 * MINUTE }, fakeSgo(), () => now);
    const find = async () =>
      (await p.getEvents(window)).find((e) => e.externalId === 'sgo-completed')!;
    expect(await find()).toMatchObject({ status: 'FINISHED', resultFinal: false });
    now += 5 * MINUTE;
    expect(await find()).toMatchObject({ status: 'FINISHED', resultFinal: true });
    // Without the option only "finalized" counts.
    const { provider: strict } = provider({}, fakeSgo(), () => now + 60 * MINUTE);
    const e = (await strict.getEvents(window)).find((x) => x.externalId === 'sgo-completed')!;
    expect(e.resultFinal).toBe(false);
  });

  it('shows the running period, the clock and the team figures the feed reports', async () => {
    const { provider: p } = provider();
    const live = (await p.getEvents(window)).find((e) => e.externalId === 'sgo-live')!;
    expect(live.liveState).toEqual({ period: '1H', clock: "38'" });
    expect(live.statistics).toEqual({
      sport: 'football',
      goals: { home: 1, away: 0 },
      corners: { home: 4, away: 2 },
      yellowCards: { home: 1, away: 2 },
      redCards: { home: 0, away: 0 },
      // Figures without a named field are kept under the feed's own id.
      teamStats: [{ key: 'shots', home: 7, away: 3 }],
    });
    // Total corners from the feed's corner stat.
    const corners = (await p.getMarkets('sgo-upcoming')).find((m) => m.type === 'TOTAL_CORNERS');
    expect(corners).toMatchObject({ key: 'TOTAL_CORNERS:9.5', line: 9.5 });
  });

  it('skips quarter lines and markets without bookmaker margin', async () => {
    const { provider: p } = provider();
    await p.getEvents(window);
    expect(quoted(await p.getMarkets('sgo-quarter')).map((m) => m.key)).toEqual(['MATCH_RESULT']);
    expect(await p.getMarkets('sgo-no-margin')).toEqual([]);
  });

  it('maps basketball and tennis', async () => {
    const { provider: p } = provider();
    await p.getEvents(window);
    const nba = fullGame(await p.getMarkets('nba-1'));
    expect(nba.map((m) => m.key).sort()).toEqual([
      'MATCH_WINNER',
      'POINT_SPREAD:-7.5',
      'TOTAL_POINTS:214.5',
    ]);
    expect(prices(nba.find((m) => m.type === 'MATCH_WINNER'))).toEqual({ HOME: 1.364, AWAY: 3.2 });
    const tennis = await p.getMarkets('atp-1');
    expect(tennis.map((m) => m.key)).toEqual(['MATCH_WINNER']);
    expect(prices(tennis[0])).toEqual({ HOME: 1.3, AWAY: 3.6 });
  });

  it('offers first- and second-half markets from the half periods', async () => {
    const { provider: p } = provider();
    await p.getEvents(window);
    const football = await p.getMarkets('sgo-upcoming');
    const byType = (t: string) => football.find((m) => m.type === t);
    expect(prices(byType('HALF_TIME_RESULT'))).toEqual({ HOME: 2.2, DRAW: 2.3, AWAY: 4 });
    expect(byType('FIRST_HALF_HANDICAP')).toMatchObject({ key: 'FIRST_HALF_HANDICAP:-0.5' });
    expect(prices(byType('FIRST_HALF_TOTAL_GOALS'))).toEqual({ OVER: 2.05, UNDER: 1.8 });
    expect(prices(byType('SECOND_HALF_RESULT'))).toEqual({ HOME: 2.05, DRAW: 3.2, AWAY: 4.2 });
    expect(byType('SECOND_HALF_TOTAL_GOALS')).toMatchObject({
      key: 'SECOND_HALF_TOTAL_GOALS:1.5',
      name: '2. Halbzeit – Tore Über/Unter 1.5',
    });

    const nba = await p.getMarkets('nba-1');
    expect(prices(nba.find((m) => m.type === 'FIRST_HALF_WINNER'))).toEqual({
      HOME: 1.417,
      AWAY: 2.95,
    });
    expect(nba.map((m) => m.key)).toEqual(
      expect.arrayContaining(['FIRST_HALF_SPREAD:-4.5', 'FIRST_HALF_TOTAL_POINTS:108.5']),
    );
  });

  it('offers player markets only for players of the two teams', async () => {
    const { provider: p } = provider();
    const [event] = (await p.getEvents(window)).filter((e) => e.externalId === 'sgo-upcoming');
    expect(event!.home.players.map((pl) => pl.externalId).sort()).toEqual([
      'HARRY_KANE_1_BUNDESLIGA',
      'JAMAL_MUSIALA_1_BUNDESLIGA',
    ]);
    expect(event!.away.players.map((pl) => pl.name)).toEqual(['Serhou Guirassy']);

    const scorer = (await p.getMarkets('sgo-upcoming')).find((m) => m.type === 'PLAYER_TO_SCORE')!;
    // "yes" or over 0.5 goals; the player of another team is left out.
    expect(scorer.selections.map((s) => [s.key, s.name, s.odds, s.playerExternalId])).toEqual([
      ['PLAYER:HARRY_KANE_1_BUNDESLIGA', 'Harry Kane', 1.833, 'HARRY_KANE_1_BUNDESLIGA'],
      ['PLAYER:JAMAL_MUSIALA_1_BUNDESLIGA', 'Jamal Musiala', 3.1, 'JAMAL_MUSIALA_1_BUNDESLIGA'],
      [
        'PLAYER:SERHOU_GUIRASSY_1_BUNDESLIGA',
        'Serhou Guirassy',
        3.5,
        'SERHOU_GUIRASSY_1_BUNDESLIGA',
      ],
    ]);

    const nba = await p.getMarkets('nba-1');
    const players = nba.filter((m) => m.type.startsWith('PLAYER_'));
    expect(players.map((m) => m.key).sort()).toEqual([
      'PLAYER_ASSISTS:JIMMY_BUTLER_1_NBA:5.5',
      'PLAYER_POINTS:JAYSON_TATUM_1_NBA:27.5',
      'PLAYER_REBOUNDS:JAYSON_TATUM_1_NBA:8.5',
    ]);
    const tatum = players.find((m) => m.type === 'PLAYER_POINTS')!;
    expect(tatum).toMatchObject({ name: 'Jayson Tatum – Punkte Über/Unter 27.5', line: 27.5 });
    expect(tatum.selections.map((s) => [s.outcome, s.name, s.odds, s.playerExternalId])).toEqual([
      ['OVER', 'Über 27.5', 1.87, 'JAYSON_TATUM_1_NBA'],
      ['UNDER', 'Unter 27.5', 1.952, 'JAYSON_TATUM_1_NBA'],
    ]);
  });

  it('reads halves, quarters and player stat lines from the official result', async () => {
    let now = T0;
    const { provider: p } = provider({}, fakeSgo(), () => now);
    await p.getEvent('sgo-finished');
    await p.getEvent('nba-finished');
    now += 3 * MINUTE;
    expect((await p.getEvent('sgo-finished'))!.statistics).toEqual({
      sport: 'football',
      goals: { home: 2, away: 2 },
      firstHalf: { home: 1, away: 0 },
      secondHalf: { home: 1, away: 2 },
      players: [
        { playerId: 'LOIS_OPENDA_1_BUNDESLIGA', name: 'Loïs Openda', stats: { goals: 2 } },
        { playerId: 'XAVI_SIMONS_1_BUNDESLIGA', name: 'Xavi Simons', stats: { goals: 0 } },
        { playerId: 'PATRIK_SCHICK_1_BUNDESLIGA', name: 'Patrik Schick', stats: { goals: 2 } },
      ],
    });
    const nba = (await p.getEvent('nba-finished'))!;
    expect(nba).toMatchObject({ status: 'FINISHED', resultFinal: true });
    expect(nba.statistics).toMatchObject({
      sport: 'basketball',
      points: { home: 112, away: 104 },
      firstHalf: { home: 56, away: 52 },
      periods: [
        { home: 30, away: 24 },
        { home: 26, away: 28 },
        { home: 29, away: 25 },
        { home: 27, away: 27 },
      ],
      players: [
        {
          playerId: 'NIKOLA_JOKIC_1_NBA',
          name: 'Nikola Jokić',
          stats: { points: 31, rebounds: 13, assists: 9 },
        },
        {
          playerId: 'LEBRON_JAMES_1_NBA',
          name: 'LeBron James',
          stats: { points: 27, rebounds: 8, assists: 11 },
        },
      ],
    });
  });

  it('shows running games with their score and suspends live prices by default', async () => {
    const { provider: p } = provider();
    const live = await p.getLiveEvents();
    expect(live.map((e) => e.externalId)).toEqual(['sgo-live']);
    expect(live[0]).toMatchObject({ status: 'LIVE', score: { home: 1, away: 0 } });
    const markets = await p.getMarkets('sgo-live');
    expect(markets[0]).toMatchObject({
      status: 'SUSPENDED',
      suspensionReason: 'Live-Quoten nicht aktuell genug',
    });

    const { provider: enabled } = provider({ liveBetting: true });
    expect((await enabled.getMarkets('sgo-live'))[0]!.status).toBe('OPEN');
  });

  it('looks up unknown events and settles only safe results', async () => {
    let now = T0;
    const { provider: p } = provider({}, fakeSgo(), () => now);
    // Finalized games are not in the open-events snapshot: first seen as unknown.
    // (A cancelled one is still open there and known right away.)
    expect(await p.getEvent('sgo-finished')).toBeNull();
    expect(await p.getEvent('ucl-extra-time')).toBeNull();
    now += 3 * MINUTE;

    expect(await p.getEvent('sgo-finished')).toMatchObject({
      status: 'FINISHED',
      score: { home: 2, away: 2 },
      statistics: { sport: 'football', goals: { home: 2, away: 2 } },
      resultFinal: true,
    });
    // Decided in extra time: the regular-time result is left to staff.
    expect(await p.getEvent('ucl-extra-time')).toMatchObject({
      status: 'FINISHED',
      resultFinal: false,
    });
    expect(await p.getEvent('sgo-cancelled')).toMatchObject({
      status: 'CANCELLED',
      resultFinal: true,
    });
    expect(await p.getMarkets('sgo-finished')).toEqual([]);
  });

  it('refreshes the snapshot on its TTL and running games more often', async () => {
    let now = T0;
    const { provider: p, api } = provider({}, fakeSgo(), () => now);
    const eventCalls = () => api.calls.filter((c) => c.path === '/events');
    await p.getEvents(window);
    await p.getEvents(window);
    await p.getMarkets('sgo-upcoming');
    expect(eventCalls()).toHaveLength(2); // snapshot + the one running game
    expect(eventCalls()[0]!.params.get('finalized')).toBe('false');
    expect(eventCalls()[0]!.params.get('leagueID')).toBe(
      'BUNDESLIGA,UEFA_CHAMPIONS_LEAGUE,NBA,ATP',
    );
    expect(eventCalls()[1]!.params.get('eventIDs')).toBe('sgo-live,sgo-completed');
    expect(eventCalls()[1]!.params.get('expandResults')).toBe('true');

    now += 2 * MINUTE;
    await p.getEvents(window);
    expect(eventCalls()).toHaveLength(3);
    expect(eventCalls()[2]!.params.get('eventIDs')).toBe('sgo-live,sgo-completed');

    now += 30 * MINUTE;
    await p.getEvents(window);
    expect(
      eventCalls()
        .slice(3)
        .map((c) => c.params.has('eventIDs')),
    ).toEqual([false, true]);
  });

  it('tracks the monthly object quota and stops below the reserve', async () => {
    let now = T0;
    const api = fakeSgo({ max: 2_500, used: 2_445 });
    const { provider: p } = provider({ minRemainingObjects: 50 }, api, () => now);
    await p.getEvents(window);
    // 55 left before the snapshot; its 7 events push the count below the reserve.
    expect(p.getQuota().exhausted).toBe(true);
    expect(p.getQuota().remaining).toBeLessThanOrEqual(50);
    const calls = api.calls.length;
    now += 3 * MINUTE;
    await p.getEvents(window);
    expect(api.calls.filter((c) => c.path === '/events').length).toBe(1);
    expect(api.calls.length).toBe(calls);
    expect((await p.getMarkets('sgo-upcoming'))[0]).toMatchObject({
      status: 'SUSPENDED',
      suspensionReason: 'Datenkontingent erschöpft',
    });
  });

  it('classifies HTTP failures for the resilience layer', async () => {
    const unauthorised = provider({}, fakeSgo({ status: 401 })).provider;
    const error = (await unauthorised.getEvents(window).catch((e: unknown) => e)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('API key is invalid');

    const limited = provider({}, fakeSgo({ status: 429 })).provider;
    expect(await limited.getEvents(window).catch((e: unknown) => e)).toBeInstanceOf(
      ProviderRateLimitedError,
    );

    const down = provider({}, fakeSgo({ status: 503 })).provider;
    const failure = (await down.getEvents(window).catch((e: unknown) => e)) as ProviderError;
    expect(failure.retryable).toBe(true);
  });

  it('requires an API key', () => {
    expect(() => provider({ apiKey: '' })).toThrow(/API key/);
  });
});
