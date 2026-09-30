import { describe, expect, it } from 'vitest';
import {
  acceptOdds,
  betTypeFor,
  cashoutValue,
  combineOdds,
  decideBet,
  decideSystem,
  evaluateSlip,
  systemLines,
  potentialReturn,
  resolveSelection,
  SettlementDataError,
  toMilli,
  type BookSelection,
} from '../src/domain';
import type { BasketballStatistics, FootballStatistics, TennisStatistics } from '@storm-bet/types';

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
    stats: FootballStatistics | TennisStatistics | BasketballStatistics,
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

  it('settles half-time markets on the half, never on the full-time score', () => {
    const halves = football(3, 1, { firstHalf: { home: 0, away: 1 } });
    expect(r('HALF_TIME_RESULT', 'AWAY', halves)).toBe('WON');
    expect(r('HALF_TIME_RESULT', 'HOME', halves)).toBe('LOST');
    expect(r('FIRST_HALF_TOTAL_GOALS', 'UNDER', halves, 1.5)).toBe('WON');
    expect(r('FIRST_HALF_HANDICAP', 'HOME', halves, 1)).toBe('VOID');
    // Second half derived from full time minus first half: 3:0.
    expect(r('SECOND_HALF_RESULT', 'HOME', halves)).toBe('WON');
    expect(r('SECOND_HALF_TOTAL_GOALS', 'OVER', halves, 2.5)).toBe('WON');
    expect(
      r('SECOND_HALF_RESULT', 'DRAW', football(3, 1, { secondHalf: { home: 1, away: 1 } })),
    ).toBe('WON');
    // No half-time score recorded: left to staff, not guessed.
    expect(() => r('HALF_TIME_RESULT', 'HOME', football(1, 0))).toThrow(SettlementDataError);

    const basketball = (extra: Partial<BasketballStatistics>): BasketballStatistics => ({
      sport: 'basketball',
      points: { home: 110, away: 104 },
      periods: [],
      ...extra,
    });
    const quarters = basketball({
      periods: [
        { home: 30, away: 20 },
        { home: 25, away: 30 },
        { home: 28, away: 27 },
        { home: 27, away: 27 },
      ],
    });
    expect(r('FIRST_HALF_WINNER', 'HOME', quarters)).toBe('WON');
    expect(r('FIRST_HALF_TOTAL_POINTS', 'OVER', quarters, 104.5)).toBe('WON');
    expect(r('FIRST_HALF_SPREAD', 'AWAY', quarters, -5)).toBe('VOID');
    expect(r('FIRST_HALF_WINNER', 'AWAY', basketball({ firstHalf: { home: 50, away: 50 } }))).toBe(
      'VOID',
    );
    expect(() => r('FIRST_HALF_WINNER', 'HOME', basketball({}))).toThrow(SettlementDataError);
  });

  it('settles player markets from official stat lines', () => {
    const stats: BasketballStatistics = {
      sport: 'basketball',
      points: { home: 110, away: 104 },
      periods: [],
      players: [
        { playerId: 'p1', name: 'A', stats: { points: 28, rebounds: 7, assists: 9 } },
        { playerId: 'p2', name: 'B', stats: { points: 12 } },
      ],
    };
    expect(r('PLAYER_POINTS', 'OVER', stats, 27.5, 'p1')).toBe('WON');
    expect(r('PLAYER_REBOUNDS', 'UNDER', stats, 7.5, 'p1')).toBe('WON');
    expect(r('PLAYER_ASSISTS', 'OVER', stats, 9, 'p1')).toBe('VOID');
    // Did not play: void. Figure not recorded: manual.
    expect(r('PLAYER_POINTS', 'OVER', stats, 10.5, 'p3')).toBe('VOID');
    expect(() => r('PLAYER_REBOUNDS', 'OVER', stats, 3.5, 'p2')).toThrow(SettlementDataError);
    expect(() => r('PLAYER_POINTS', 'OVER', { ...stats, players: undefined }, 10.5, 'p1')).toThrow(
      SettlementDataError,
    );

    const scorers = football(2, 0, {
      goalEvents: undefined,
      players: [
        { playerId: 'kane', name: 'Kane', stats: { goals: 2 } },
        { playerId: 'musiala', name: 'Musiala', stats: { goals: 0 } },
      ],
    });
    expect(r('PLAYER_TO_SCORE', 'PLAYER', scorers, null, 'kane')).toBe('WON');
    expect(r('PLAYER_TO_SCORE', 'PLAYER', scorers, null, 'musiala')).toBe('LOST');
    expect(r('PLAYER_TO_SCORE', 'PLAYER', scorers, null, 'bench')).toBe('VOID');
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

describe('cashoutValue', () => {
  const bet = { type: 'DOUBLE' as const, stake: 1_000n, potentialReturn: 4_000n };
  const open = (placed: number, current: number) => ({
    oddsMilli: placed,
    result: 'PENDING' as const,
    book: book('x', { oddsMilli: current }),
  });

  it('values won legs at their odds and open legs at placed ÷ current, less the margin', () => {
    const won = { oddsMilli: 2_000, result: 'WON' as const, book: undefined };
    // 10,00 × 2.00 × (2.00 / 1.25) × 0.95 = 30,40
    expect(cashoutValue(bet, [won, open(2_000, 1_250)], now, 5)).toEqual({
      available: true,
      amount: 3_040n,
    });
    // Never above the potential return.
    expect(
      cashoutValue({ ...bet, potentialReturn: 3_000n }, [won, open(2_000, 1_010)], now, 0),
    ).toEqual({ available: true, amount: 3_000n });
  });

  it('offers nothing for a lost leg, a suspended market or a Bet Builder', () => {
    const lost = { oddsMilli: 2_000, result: 'LOST' as const, book: undefined };
    expect(cashoutValue(bet, [lost, open(2_000, 1_500)], now, 5).available).toBe(false);
    const suspended = { ...open(2_000, 1_500), book: book('x', { marketStatus: 'SUSPENDED' }) };
    expect(cashoutValue(bet, [suspended], now, 5).available).toBe(false);
    expect(
      cashoutValue({ ...bet, type: 'BET_BUILDER' }, [open(2_000, 1_500)], now, 5).available,
    ).toBe(false);
  });
});

describe('score-only sports', () => {
  it('settles winner, handicap and total from the score', () => {
    const hockey = { sport: 'hockey' as const, score: { home: 3, away: 2 }, periods: [] };
    const leg = (
      marketType: 'MATCH_WINNER' | 'POINT_SPREAD' | 'TOTAL_POINTS',
      line: number | null,
      outcome: 'HOME' | 'AWAY' | 'OVER',
    ) => resolveSelection({ marketType, line, outcome, playerId: null }, 'FINISHED', hockey);
    expect(leg('MATCH_WINNER', null, 'HOME')).toBe('WON');
    expect(leg('POINT_SPREAD', -1.5, 'HOME')).toBe('LOST');
    expect(leg('TOTAL_POINTS', 5.5, 'OVER')).toBe('LOST');
    // A drawn NFL game voids the winner bet.
    const tie = { sport: 'american_football' as const, score: { home: 20, away: 20 }, periods: [] };
    expect(
      resolveSelection(
        { marketType: 'MATCH_WINNER', line: null, outcome: 'HOME', playerId: null },
        'FINISHED',
        tie,
      ),
    ).toBe('VOID');
  });
});

describe('combined player figures', () => {
  it('settles points + rebounds + assists on their sum', () => {
    const stats = {
      sport: 'basketball' as const,
      points: { home: 100, away: 90 },
      periods: [],
      players: [{ playerId: 'p1', name: 'A', stats: { points: 25, rebounds: 8, assists: 7 } }],
    };
    const pra = (line: number) =>
      resolveSelection(
        { marketType: 'PLAYER_PRA', line, outcome: 'OVER', playerId: 'p1' },
        'FINISHED',
        stats,
      );
    expect(pra(39.5)).toBe('WON');
    expect(pra(40.5)).toBe('LOST');
  });
});

describe('system bets', () => {
  const b = new Map([
    ['a', book('a', { oddsMilli: 2000 })],
    ['b', book('b', { oddsMilli: 3000 })],
    ['c', book('c', { oddsMilli: 4000 })],
  ]);
  const legs = [
    { selectionId: 'a', requestedOddsMilli: 2000 },
    { selectionId: 'b', requestedOddsMilli: 3000 },
    { selectionId: 'c', requestedOddsMilli: 4000 },
  ];

  it('counts combinations', () => {
    expect([systemLines(3, 2), systemLines(4, 2), systemLines(5, 3), systemLines(8, 4)]).toEqual([
      3, 6, 10, 70,
    ]);
  });

  it('quotes 2 of 3: one stake per combination', () => {
    const result = evaluateSlip(
      { mode: 'SYSTEM', stake: 100n, systemSize: 2, policy: 'REJECT', legs },
      b,
      { now, limits, requireStake: true },
    );
    expect(result.issues).toEqual([]);
    expect(result.betType).toBe('SYSTEM');
    expect(result.bets[0]).toMatchObject({ stake: 300n, systemSize: 2 });
    // 6.00 + 8.00 + 12.00 per 1,00 €
    expect(result.potentialReturn).toBe(2_600n);
    expect(result.totalOddsMilli).toBe(8_666n);
  });

  it('refuses a size that is no system, legs of one match and a tiny stake', () => {
    const bad = (systemSize: number, stake = 100n, book2 = b) =>
      evaluateSlip({ mode: 'SYSTEM', stake, systemSize, policy: 'REJECT', legs }, book2, {
        now,
        limits,
        requireStake: true,
      }).issues.map((i) => i.code);
    expect(bad(3)).toContain('VALIDATION_ERROR');
    expect(bad(1)).toContain('VALIDATION_ERROR');
    expect(bad(2, 5n)).toContain('BET_LIMIT_EXCEEDED');
    const sameMatch = new Map(b);
    sameMatch.set('c', book('c', { oddsMilli: 4000, eventId: 'e-a' }));
    expect(bad(2, 100n, sameMatch)).toContain('VALIDATION_ERROR');
  });

  it('settles each combination like a multiple', () => {
    const r = (odds: number, result: 'WON' | 'LOST' | 'VOID' | 'PENDING') => ({ odds, result });
    expect(decideSystem(300n, 2, [r(2000, 'WON'), r(3000, 'LOST'), r(4000, 'WON')])).toMatchObject({
      status: 'WON',
      payout: 800n,
    });
    expect(decideSystem(300n, 2, [r(2000, 'VOID'), r(3000, 'WON'), r(4000, 'WON')])).toMatchObject({
      status: 'WON',
      payout: 1_900n,
    });
    // Two lost of three: no combination can win any more.
    expect(
      decideSystem(300n, 2, [r(2000, 'LOST'), r(3000, 'LOST'), r(4000, 'PENDING')]),
    ).toMatchObject({ status: 'LOST', payout: 0n });
    expect(decideSystem(300n, 2, [r(2000, 'LOST'), r(3000, 'WON'), r(4000, 'PENDING')])).toEqual({
      decided: false,
    });
    expect(
      decideSystem(300n, 2, [r(2000, 'VOID'), r(3000, 'VOID'), r(4000, 'VOID')]),
    ).toMatchObject({ status: 'VOID', payout: 300n });
  });

  it('has no cashout', () => {
    expect(
      cashoutValue({ type: 'SYSTEM', stake: 300n, potentialReturn: 2_600n }, [], now, 5),
    ).toMatchObject({ available: false });
  });
});
