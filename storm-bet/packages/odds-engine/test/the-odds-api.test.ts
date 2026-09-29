import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  ProviderRateLimitedError,
  TheOddsApiProvider,
  type TheOddsApiOptions,
} from '../src';
import { fakeApi, T0 } from './the-odds-api.fixtures';

function provider(overrides: Partial<TheOddsApiOptions> = {}, api = fakeApi(), now = () => T0) {
  return {
    api,
    provider: new TheOddsApiProvider({
      apiKey: 'test-key-1234567890',
      baseUrl: 'https://api.test/v4',
      sports: ['soccer_germany_bundesliga', 'basketball_nba', 'tennis_*', 'americanfootball_nfl'],
      regions: 'eu',
      bookmakers: [],
      oddsTtlMs: 600_000,
      scoresTtlMs: 300_000,
      minRemainingCredits: 25,
      liveBetting: false,
      liveMaxAgeMs: 60_000,
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

describe('TheOddsApiProvider', () => {
  it('marks its data as real and maps only supported, active competitions', async () => {
    const { provider: p } = provider();
    expect(p.isSimulated).toBe(false);
    const leagues = await p.getLeagues();
    expect(leagues.map((l) => l.externalId).sort()).toEqual([
      'basketball_nba',
      'soccer_germany_bundesliga',
      'tennis_atp_paris',
    ]);
    expect(leagues.find((l) => l.externalId === 'tennis_atp_paris')?.sportKey).toBe('tennis');
    expect((await p.getSports()).map((s) => s.key).sort()).toEqual([
      'basketball',
      'football',
      'tennis',
    ]);
  });

  it('maps match result, handicap and totals from one bookmaker', async () => {
    const { provider: p } = provider({ bookmakers: ['pinnacle'] });
    await p.getEvents({ ...window });
    const markets = await p.getMarkets('bl-upcoming');
    expect(markets.map((m) => m.key)).toEqual([
      'MATCH_RESULT',
      'ASIAN_HANDICAP:-1.5',
      'TOTAL_GOALS:3.5',
    ]);
    const result = markets[0]!;
    expect(result.selections.map((s) => [s.outcome, s.name, s.odds])).toEqual([
      ['HOME', 'Bayern Munich', 1.61],
      ['DRAW', 'Unentschieden', 4.55],
      ['AWAY', 'Borussia Dortmund', 5.02],
    ]);
    expect(markets[1]!.selections.map((s) => s.name)).toEqual([
      'Bayern Munich -1.5',
      'Borussia Dortmund +1.5',
    ]);
    expect(markets.every((m) => m.status === 'OPEN')).toBe(true);
  });

  it('falls back to the first bookmaker with a match market', async () => {
    const { provider: p } = provider({ bookmakers: [] });
    await p.getEvents({ ...window });
    const markets = await p.getMarkets('bl-upcoming');
    expect(markets.map((m) => m.key)).toEqual(['MATCH_RESULT']);
    expect(markets[0]!.selections[0]!.odds).toBe(1.55);
  });

  it('skips quarter lines instead of settling them wrongly', async () => {
    const { provider: p } = provider();
    await p.getEvents({ ...window });
    expect((await p.getMarkets('bl-quarter')).map((m) => m.key)).toEqual(['MATCH_RESULT']);
  });

  it('maps two-way sports and restricts tennis to the winner market', async () => {
    const { provider: p, api } = provider();
    await p.getEvents({ ...window });
    expect((await p.getMarkets('nba-1')).map((m) => m.key)).toEqual([
      'MATCH_WINNER',
      'POINT_SPREAD:-7.5',
      'TOTAL_POINTS:214.5',
    ]);
    expect((await p.getMarkets('atp-1')).map((m) => m.type)).toEqual(['MATCH_WINNER']);
    const tennisCall = api.calls.find((c) => c.path.includes('tennis') && c.path.endsWith('/odds'));
    expect(tennisCall?.params.get('markets')).toBe('h2h');
  });

  it('derives live and finished states from the scores feed, with score-only statistics', async () => {
    const { provider: p } = provider();
    const events = await p.getEvents({ ...window });
    const live = events.find((e) => e.externalId === 'bl-live')!;
    expect(live.status).toBe('LIVE');
    expect(live.score).toEqual({ home: 1, away: 0 });
    const finished = events.find((e) => e.externalId === 'bl-finished')!;
    expect(finished).toMatchObject({
      status: 'FINISHED',
      resultFinal: true,
      score: { home: 2, away: 2 },
    });
    // Only the score is known — no invented corners, cards or possession.
    expect(finished.statistics).toEqual({ sport: 'football', goals: { home: 2, away: 2 } });
    expect((await p.getLiveEvents()).map((e) => e.externalId)).toEqual(['bl-live']);
  });

  it('suspends in-play markets unless live betting is enabled and the snapshot is fresh', async () => {
    let now = T0;
    const off = provider({}, fakeApi(), () => now).provider;
    await off.getEvents({ ...window });
    const suspended = await off.getMarkets('bl-live');
    expect(suspended[0]).toMatchObject({
      status: 'SUSPENDED',
      suspensionReason: 'Live-Quoten nicht aktuell genug',
    });

    const on = provider({ liveBetting: true }, fakeApi(), () => now).provider;
    await on.getEvents({ ...window });
    expect((await on.getMarkets('bl-live'))[0]!.status).toBe('OPEN');
    now += 120_000; // snapshot older than liveMaxAge
    expect((await on.getMarkets('bl-live'))[0]!.status).toBe('SUSPENDED');
  });

  it('spends credits sparingly: one odds call per competition per TTL, scores only while games run', async () => {
    let now = T0;
    const { provider: p, api } = provider({}, fakeApi(), () => now);
    await p.getEvents({ ...window });
    await p.getLiveEvents();
    await p.getMarkets('bl-upcoming');
    await p.getEvent('nba-1');
    const odds = api.calls.filter((c) => c.path.endsWith('/odds'));
    expect(odds).toHaveLength(3); // bundesliga, nba, tennis
    const scores = api.calls.filter((c) => c.path.endsWith('/scores'));
    expect(scores.map((c) => c.path)).toEqual(['/sports/soccer_germany_bundesliga/scores']); // only there a game is running
    now += 601_000;
    await p.getEvents({ ...window });
    expect(api.calls.filter((c) => c.path.endsWith('/odds'))).toHaveLength(6);
    expect(p.getQuota()).toMatchObject({ exhausted: false });
    expect(p.getQuota().remaining).toBeLessThan(480);
  });

  it('stops spending below the credit reserve and suspends markets', async () => {
    let now = T0;
    const { provider: p, api } = provider(
      { minRemainingCredits: 25 },
      fakeApi({ remaining: 30 }),
      () => now,
    );
    await p.getEvents({ ...window });
    expect(p.getQuota().exhausted).toBe(true);
    const callsBefore = api.calls.length;
    now += 3_600_001;
    await p.getEvents({ ...window });
    expect(api.calls.length).toBe(callsBefore + 1); // only the free sports list is refreshed
    expect((await p.getMarkets('bl-upcoming'))[0]).toMatchObject({
      status: 'SUSPENDED',
      suspensionReason: 'Datenkontingent erschöpft',
    });
  });

  it('asks only the configured bookmakers when a preference is set', async () => {
    const { provider: p, api } = provider({ bookmakers: ['pinnacle', 'unibet_eu'] });
    await p.getEvents({ ...window });
    const call = api.calls.find((c) => c.path.endsWith('/odds'))!;
    expect(call.params.get('bookmakers')).toBe('pinnacle,unibet_eu');
    expect(call.params.get('regions')).toBeNull();
    expect(call.params.get('oddsFormat')).toBe('decimal');
  });

  it('classifies HTTP failures for the resilience layer', async () => {
    const unauthorised = provider({}, fakeApi({ status: 401 })).provider;
    const error = await unauthorised.getLeagues().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(false);
    expect((error as ProviderError).message).toBe('The Odds API responded 401 for /sports: error');

    // A proxy blocking the host answers in plain text; the reason must reach the log.
    const blockedFetch = (async () =>
      new Response('Host not in allowlist: api.the-odds-api.com.', {
        status: 403,
        headers: { 'content-type': 'text/plain' },
      })) as typeof fetch;
    const blocked = provider({ fetch: blockedFetch }).provider;
    expect(((await blocked.getLeagues().catch((e: unknown) => e)) as Error).message).toContain(
      'Host not in allowlist',
    );

    const limited = provider({}, fakeApi({ status: 429 })).provider;
    expect(await limited.getLeagues().catch((e: unknown) => e)).toBeInstanceOf(
      ProviderRateLimitedError,
    );

    const down = provider({}, fakeApi({ status: 503 })).provider;
    expect(((await down.getLeagues().catch((e: unknown) => e)) as ProviderError).retryable).toBe(
      true,
    );
  });

  it('refuses to start without an API key', () => {
    expect(() => provider({ apiKey: '' })).toThrow(/API key/);
  });
});
