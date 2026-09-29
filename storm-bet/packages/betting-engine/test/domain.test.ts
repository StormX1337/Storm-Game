import { describe, expect, it } from 'vitest';
import {
  acceptOdds,
  betTypeFor,
  combineOdds,
  decideBet,
  evaluateSlip,
  potentialReturn,
  resolveSelection,
  SettlementDataError,
  toMilli,
  type BookSelection,
} from '../src/domain';
import type { FootballStatistics, TennisStatistics } from '@storm-bet/types';

const limits = {
  minStake: 10,
  maxStake: 1_000_000,
  maxPayout: 25_000_000,
  maxSelections: 20,
  maxTotalOdds: 10_000,
  acceptHigherMaxPct: 10,
};
const now = new Date('2026-09-29T12:00:00Z');

function book(id: string, overrides: Partial<BookSelection> = {}): BookSelection {
  return {
    selectionId: id,
    selectionName: `Sel ${id}`,
    outcome: 'HOME',
    selectionStatus: 'OPEN',
    oddsMilli: 1650,
    oddsVersion: 1,
    marketId: `m-${id}`,
    marketName: 'Ergebnis (1X2)',
    marketType: 'MATCH_RESULT',
    line: null,
    marketStatus: 'OPEN',
    marketTradingSuspended: false,
    eventId: `e-${id}`,
    eventName: 'A vs B',
    eventStatus: 'SCHEDULED',
    eventIsActive: true,
    eventTradingSuspended: false,
    startTime: new Date(now.getTime() + 3_600_000),
    homeScore: null,
    awayScore: null,
    provider: 'mock',
    ...overrides,
  };
}

describe('odds arithmetic', () => {
  it('combines the documented example exactly: 1.65 × 1.80 = 2.97', () => {
    const total = combineOdds([toMilli(1.65), toMilli(1.8)]);
    expect(total).toBe(2970n);
    expect(potentialReturn(1_000n, total)).toBe(2_970n);
  });

  it('truncates combined odds to three decimals', () => {
    expect(combineOdds([1833, 1910])).toBe(3501n); // 3.50103
    expect(potentialReturn(333n, 3501n)).toBe(1165n); // 11.65833 → 11.65
  });

  it('rejects impossible odds', () => {
    expect(() => toMilli(1)).toThrow();
    expect(() => toMilli(1.2345)).toThrow();
  });

  it('names bet types by leg count', () => {
    expect([1, 2, 3, 4, 9].map(betTypeFor)).toEqual([
      'SINGLE',
      'DOUBLE',
      'TRIPLE',
      'ACCUMULATOR',
      'ACCUMULATOR',
    ]);
  });
});

describe('odds change policy', () => {
  it('never accepts a shortened price', () => {
    expect(acceptOdds(1800, 1750, 'ACCEPT_HIGHER', 10)).toBe(false);
    expect(acceptOdds(1800, 1750, 'REJECT', 10)).toBe(false);
  });

  it('accepts a longer price only when the player opted in, and only within bounds', () => {
    expect(acceptOdds(1800, 1850, 'REJECT', 10)).toBe(false);
    expect(acceptOdds(1800, 1850, 'ACCEPT_HIGHER', 10)).toBe(true);
    expect(acceptOdds(1800, 1980, 'ACCEPT_HIGHER', 10)).toBe(true);
    expect(acceptOdds(1800, 1990, 'ACCEPT_HIGHER', 10)).toBe(false);
  });
});

describe('evaluateSlip', () => {
  const opts = { now, limits, requireStake: true };

  it('quotes a double', () => {
    const b = new Map([
      ['a', book('a', { oddsMilli: 1650 })],
      ['b', book('b', { oddsMilli: 1800 })],
    ]);
    const result = evaluateSlip(
      {
        mode: 'COMBO',
        stake: 1_000n,
        policy: 'REJECT',
        legs: [
          { selectionId: 'a', requestedOddsMilli: 1650 },
          { selectionId: 'b', requestedOddsMilli: 1800 },
        ],
      },
      b,
      opts,
    );
    expect(result.issues).toEqual([]);
    expect(result.betType).toBe('DOUBLE');
    expect(result.totalOddsMilli).toBe(2970n);
    expect(result.potentialReturn).toBe(2_970n);
  });

  it('reports changed odds with the current price', () => {
    const b = new Map([['a', book('a', { oddsMilli: 1700 })]]);
    const result = evaluateSlip(
      {
        mode: 'COMBO',
        stake: 100n,
        policy: 'REJECT',
        legs: [{ selectionId: 'a', requestedOddsMilli: 1650 }],
      },
      b,
      opts,
    );
    expect(result.issues[0]).toMatchObject({
      code: 'ODDS_CHANGED',
      currentOdds: 1.7,
      requestedOdds: 1.65,
    });
  });

  it('blocks suspended markets, closed events and past-posting', () => {
    const b = new Map([
      ['s', book('s', { marketStatus: 'SUSPENDED' })],
      ['c', book('c', { eventStatus: 'FINISHED' })],
      ['p', book('p', { startTime: new Date(now.getTime() - 1_000) })],
      ['t', book('t', { eventTradingSuspended: true, eventStatus: 'LIVE' })],
    ]);
    const result = evaluateSlip(
      {
        mode: 'SINGLES',
        policy: 'REJECT',
        legs: ['s', 'c', 'p', 't'].map((id) => ({
          selectionId: id,
          requestedOddsMilli: 1650,
          stake: 100n,
        })),
      },
      b,
      opts,
    );
    expect(result.issues.map((i) => i.code)).toEqual([
      'MARKET_SUSPENDED',
      'EVENT_CLOSED',
      'EVENT_CLOSED',
      'MARKET_SUSPENDED',
    ]);
  });

  it('refuses to combine two selections of the same event', () => {
    const b = new Map([
      ['a', book('a', { eventId: 'same' })],
      ['b', book('b', { eventId: 'same' })],
    ]);
    const result = evaluateSlip(
      {
        mode: 'COMBO',
        stake: 100n,
        policy: 'REJECT',
        legs: [
          { selectionId: 'a', requestedOddsMilli: 1650 },
          { selectionId: 'b', requestedOddsMilli: 1650 },
        ],
      },
      b,
      opts,
    );
    expect(result.issues.map((i) => i.code)).toContain('VALIDATION_ERROR');
  });

  it('enforces stake and payout limits', () => {
    const b = new Map([['a', book('a', { oddsMilli: 500_000 })]]);
    const tooSmall = evaluateSlip(
      {
        mode: 'COMBO',
        stake: 5n,
        policy: 'REJECT',
        legs: [{ selectionId: 'a', requestedOddsMilli: 500_000 }],
      },
      b,
      opts,
    );
    expect(tooSmall.issues[0]?.code).toBe('BET_LIMIT_EXCEEDED');
    const tooBig = evaluateSlip(
      {
        mode: 'COMBO',
        stake: 100_000n,
        policy: 'REJECT',
        legs: [{ selectionId: 'a', requestedOddsMilli: 500_000 }],
      },
      b,
      opts,
    );
    expect(tooBig.issues[0]?.message).toMatch(/maximale Gewinn/);
  });
});

const football = (
  home: number,
  away: number,
  extra: Partial<FootballStatistics> = {},
): FootballStatistics => ({
  sport: 'football',
  goals: { home, away },
  corners: { home: 5, away: 5 },
  yellowCards: { home: 2, away: 1 },
  redCards: { home: 0, away: 1 },
  shotsOnTarget: { home: 5, away: 3 },
  possession: { home: 50, away: 50 },
  goalEvents: [],
  ...extra,
});

describe('settlement rules', () => {
  const r = (
    marketType: Parameters<typeof resolveSelection>[0]['marketType'],
    outcome: Parameters<typeof resolveSelection>[0]['outcome'],
    stats: FootballStatistics | TennisStatistics,
    line: number | null = null,
    playerId: string | null = null,
  ) => resolveSelection({ marketType, outcome, line, playerId }, 'FINISHED', stats);

  it('settles 1X2, double chance and draw no bet', () => {
    expect(r('MATCH_RESULT', 'HOME', football(2, 1))).toBe('WON');
    expect(r('MATCH_RESULT', 'DRAW', football(2, 1))).toBe('LOST');
    expect(r('DOUBLE_CHANCE', 'DRAW_OR_AWAY', football(1, 1))).toBe('WON');
    expect(r('DRAW_NO_BET', 'HOME', football(1, 1))).toBe('VOID');
  });

  it('settles totals and handicaps including pushes', () => {
    expect(r('TOTAL_GOALS', 'OVER', football(2, 1), 2.5)).toBe('WON');
    expect(r('TOTAL_GOALS', 'UNDER', football(2, 1), 2.5)).toBe('LOST');
    expect(r('ASIAN_HANDICAP', 'HOME', football(2, 1), -1)).toBe('VOID');
    expect(r('ASIAN_HANDICAP', 'AWAY', football(2, 1), -1.5)).toBe('WON');
    expect(r('TOTAL_CORNERS', 'OVER', football(0, 0), 9.5)).toBe('WON');
    expect(r('TOTAL_CARDS', 'UNDER', football(0, 0), 4.5)).toBe('WON'); // 2 + 1 + 1 red = 4
  });

  it('settles both teams to score and player markets', () => {
    expect(r('BOTH_TEAMS_TO_SCORE', 'YES', football(1, 0))).toBe('LOST');
    const stats = football(1, 0, {
      goalEvents: [{ minute: 10, side: 'HOME', playerId: 'p1', playerName: 'X' }],
    });
    expect(r('PLAYER_TO_SCORE', 'PLAYER', stats, null, 'p1')).toBe('WON');
    expect(r('PLAYER_TO_SCORE', 'PLAYER', stats, null, 'p2')).toBe('LOST');
  });

  it('settles tennis markets', () => {
    const t: TennisStatistics = {
      sport: 'tennis',
      sets: [
        { home: 4, away: 6 },
        { home: 7, away: 5 },
        { home: 6, away: 3 },
      ],
      setsWon: { home: 2, away: 1 },
      currentGame: null,
      server: null,
      aces: { home: 1, away: 1 },
    };
    expect(r('MATCH_WINNER', 'HOME', t)).toBe('WON');
    expect(r('FIRST_SET_WINNER', 'AWAY', t)).toBe('WON');
    expect(r('SET_BETTING', 'SETS_2_1', t)).toBe('WON');
    expect(r('TOTAL_GAMES', 'OVER', t, 30.5)).toBe('WON'); // 31 games
    expect(r('GAME_HANDICAP', 'HOME', t, -2.5)).toBe('WON'); // 17 − 2.5 > 14
    expect(r('GAME_HANDICAP', 'HOME', t, -3.5)).toBe('LOST');
  });

  it('voids everything on a cancelled event and refuses to guess otherwise', () => {
    expect(
      resolveSelection(
        { marketType: 'MATCH_RESULT', outcome: 'HOME', line: null, playerId: null },
        'CANCELLED',
        null,
      ),
    ).toBe('VOID');
    expect(() =>
      resolveSelection(
        { marketType: 'MATCH_RESULT', outcome: 'HOME', line: null, playerId: null },
        'LIVE',
        football(1, 0),
      ),
    ).toThrow(SettlementDataError);
    expect(() =>
      resolveSelection(
        { marketType: 'MATCH_RESULT', outcome: 'HOME', line: null, playerId: null },
        'FINISHED',
        null,
      ),
    ).toThrow(SettlementDataError);
  });
});

describe('decideBet', () => {
  it('pays a won accumulator at the product of its odds', () => {
    const outcome = decideBet(1_000n, [
      { odds: 1650, result: 'WON' },
      { odds: 1800, result: 'WON' },
    ]);
    expect(outcome).toEqual({
      decided: true,
      status: 'WON',
      payout: 2_970n,
      settledOddsMilli: 2970n,
    });
  });

  it('settles as lost as soon as one leg loses', () => {
    expect(
      decideBet(1_000n, [
        { odds: 1650, result: 'LOST' },
        { odds: 1800, result: 'PENDING' },
      ]),
    ).toMatchObject({
      decided: true,
      status: 'LOST',
      payout: 0n,
    });
  });

  it('waits for pending legs and counts void legs at 1.00', () => {
    expect(
      decideBet(1_000n, [
        { odds: 1650, result: 'WON' },
        { odds: 1800, result: 'PENDING' },
      ]),
    ).toEqual({ decided: false });
    expect(
      decideBet(1_000n, [
        { odds: 1650, result: 'WON' },
        { odds: 1800, result: 'VOID' },
      ]),
    ).toMatchObject({
      status: 'WON',
      payout: 1_650n,
    });
    expect(decideBet(1_000n, [{ odds: 1650, result: 'VOID' }])).toMatchObject({
      status: 'VOID',
      payout: 1_000n,
    });
  });
});
