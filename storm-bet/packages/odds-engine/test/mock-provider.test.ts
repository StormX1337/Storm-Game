import { describe, expect, it } from 'vitest';
import { MockOddsProvider, roundToLadder, priceOutcomes } from '../src';
import { __testing as tennis } from '../src/mock/tennis';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-09-29T12:00:00Z');

function provider(now: number, timeScale = 3) {
  return new MockOddsProvider({ seed: 'test-seed', timeScale, now: () => now });
}

async function upcoming(p: MockOddsProvider, now: number) {
  return p.getEvents({
    from: new Date(now).toISOString(),
    to: new Date(now + 24 * HOUR).toISOString(),
  });
}

describe('pricing', () => {
  it('rounds to the ladder', () => {
    expect(roundToLadder(1.654)).toBe(1.65);
    expect(roundToLadder(2.971)).toBe(2.98);
    expect(roundToLadder(1.0)).toBe(1.01);
    expect(roundToLadder(1234)).toBe(500);
  });

  it('applies the documented margin to a fair book', () => {
    const odds = priceOutcomes([0.5, 0.3, 0.2], 0.05);
    const overround = odds.reduce((s, o) => s + 1 / o, 0);
    expect(overround).toBeGreaterThan(1.03);
    expect(overround).toBeLessThan(1.07);
  });
});

describe('MockOddsProvider', () => {
  it('is deterministic across instances', async () => {
    const a = await upcoming(provider(T0), T0);
    const b = await upcoming(provider(T0), T0);
    expect(a.length).toBeGreaterThan(50);
    expect(a).toEqual(b);
    const first = a[0]!;
    expect(await provider(T0).getMarkets(first.externalId)).toEqual(
      await provider(T0).getMarkets(first.externalId),
    );
  });

  it('flags its data as simulated and uses fictional names', async () => {
    const p = provider(T0);
    expect(p.isSimulated).toBe(true);
    const leagues = await p.getLeagues();
    expect(leagues.map((l) => l.sportKey).sort()).toEqual(
      expect.arrayContaining(['basketball', 'football', 'tennis']),
    );
  });

  it('always has live events across the day', async () => {
    for (let h = 0; h < 24; h += 3) {
      const now = T0 + h * HOUR;
      const live = await provider(now).getLiveEvents();
      expect(live.length, `live events at +${h}h`).toBeGreaterThan(0);
      expect(live.every((e) => e.status === 'LIVE')).toBe(true);
    }
  });

  it('plays a football match from kick-off to a final result', async () => {
    const p0 = provider(T0);
    const fixture = (await upcoming(p0, T0)).find(
      (e) => e.sportKey === 'football' && e.status === 'SCHEDULED',
    )!;
    const kickoff = Date.parse(fixture.startTime);

    const before = await provider(kickoff - 60_000).getEvent(fixture.externalId);
    expect(before?.status).toBe('SCHEDULED');
    const pre = await provider(kickoff - 60_000).getMarkets(fixture.externalId);
    const oneXTwo = pre.find((m) => m.type === 'MATCH_RESULT')!;
    expect(oneXTwo.selections.map((s) => s.outcome)).toEqual(['HOME', 'DRAW', 'AWAY']);
    expect(oneXTwo.status).toBe('OPEN');

    const mid = await provider(kickoff + 10 * 60_000).getEvent(fixture.externalId);
    expect(mid?.status).toBe('LIVE');
    expect(mid?.liveState?.period).toBe('1H');

    const after = await provider(kickoff + 3 * HOUR).getEvent(fixture.externalId);
    expect(after?.status).toBe('FINISHED');
    expect(after?.resultFinal).toBe(true);
    const stats = after!.statistics!;
    expect(stats.sport).toBe('football');
    if (stats.sport === 'football') {
      expect(stats.goals).toEqual(after!.score);
      expect(stats.goalEvents).toHaveLength(stats.goals.home + stats.goals.away);
    }
    const closed = await provider(kickoff + 3 * HOUR).getMarkets(fixture.externalId);
    expect(closed.every((m) => m.status === 'CLOSED')).toBe(true);
  });

  it('never lowers a live score and keeps prices within bounds', async () => {
    const fixture = (await upcoming(provider(T0), T0)).find((e) => e.sportKey === 'football')!;
    const kickoff = Date.parse(fixture.startTime);
    let last = 0;
    for (let minute = 0; minute <= 40; minute += 2) {
      const now = kickoff + minute * 60_000;
      const event = await provider(now).getEvent(fixture.externalId);
      const total = (event?.score?.home ?? 0) + (event?.score?.away ?? 0);
      expect(total).toBeGreaterThanOrEqual(last);
      last = total;
      for (const market of await provider(now).getMarkets(fixture.externalId)) {
        for (const s of market.selections) {
          expect(s.odds).toBeGreaterThanOrEqual(1.01);
          expect(s.odds).toBeLessThanOrEqual(500);
        }
      }
    }
  });

  it('finishes tennis and basketball matches with a winner', async () => {
    const events = await upcoming(provider(T0), T0);
    for (const sport of ['tennis', 'basketball'] as const) {
      const fixture = events.find((e) => e.sportKey === sport && e.status === 'SCHEDULED')!;
      const done = await provider(Date.parse(fixture.startTime) + 5 * HOUR).getEvent(
        fixture.externalId,
      );
      expect(done?.status).toBe('FINISHED');
      expect(done!.score!.home).not.toBe(done!.score!.away);
    }
  });

  it('returns null for unknown fixtures instead of throwing', async () => {
    expect(await provider(T0).getEvent('nope:1:2')).toBeNull();
    expect(await provider(T0).getMarkets('fb-nordliga:1:99')).toEqual([]);
  });
});

describe('tennis model', () => {
  it('solves the game probability that reproduces a set probability', () => {
    for (const pSet of [0.3, 0.5, 0.72]) {
      const q = tennis.solveGameProbability(pSet);
      expect(tennis.setWinProbability(q)).toBeCloseTo(pSet, 4);
    }
  });

  it('set distributions sum to one', () => {
    const dist = tennis.setDistribution(0.55, 3, 2);
    const total = [...dist.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 9);
  });
});
