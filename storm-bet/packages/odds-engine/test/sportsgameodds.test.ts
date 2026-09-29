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
    const markets = await p.getMarkets('sgo-upcoming');
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

  it('skips quarter lines and markets without bookmaker margin', async () => {
    const { provider: p } = provider();
    await p.getEvents(window);
    expect((await p.getMarkets('sgo-quarter')).map((m) => m.key)).toEqual(['MATCH_RESULT']);
    expect(await p.getMarkets('sgo-no-margin')).toEqual([]);
  });

  it('maps basketball and tennis', async () => {
    const { provider: p } = provider();
    await p.getEvents(window);
    const nba = await p.getMarkets('nba-1');
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
    expect(eventCalls()[1]!.params.get('eventIDs')).toBe('sgo-live');

    now += 2 * MINUTE;
    await p.getEvents(window);
    expect(eventCalls()).toHaveLength(3);
    expect(eventCalls()[2]!.params.get('eventIDs')).toBe('sgo-live');

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
