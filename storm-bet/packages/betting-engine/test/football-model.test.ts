import { describe, expect, it } from 'vitest';
import {
  combinationProbability,
  decideBuilder,
  evaluateSlip,
  fitFootballModel,
  periodStates,
  priceBuilder,
  scoreStates,
  type BookSelection,
  type ModelMarket,
} from '../src/domain';

/** Fair prices of a match with known goal rates, plus a proportional margin. */
function pricesFor(home: number, away: number, margin = 0): ModelMarket[] {
  const model = { home, away, firstHalfShare: 0.45, error: 0 };
  const states = periodStates(model, 'FULL');
  const odds = (p: number) => Math.round((1 / (p * (1 + margin))) * 1000) / 1000;
  const prob = (
    marketType: ModelMarket['type'],
    line: number | null,
    outcome: 'HOME' | 'DRAW' | 'AWAY' | 'OVER' | 'UNDER',
  ) => combinationProbability(states, [{ marketType, line, outcome }]).win;
  return [
    {
      type: 'MATCH_RESULT',
      line: null,
      selections: (['HOME', 'DRAW', 'AWAY'] as const).map((o) => ({
        outcome: o,
        odds: odds(prob('MATCH_RESULT', null, o)),
      })),
    },
    {
      type: 'TOTAL_GOALS',
      line: 2.5,
      selections: (['OVER', 'UNDER'] as const).map((o) => ({
        outcome: o,
        odds: odds(prob('TOTAL_GOALS', 2.5, o)),
      })),
    },
  ];
}

describe('fitFootballModel', () => {
  it('recovers the goal rates behind a set of prices, with or without margin', () => {
    for (const margin of [0, 0.06]) {
      const model = fitFootballModel(pricesFor(1.7, 0.9, margin))!;
      expect(model.home).toBeCloseTo(1.7, 1);
      expect(model.away).toBeCloseTo(0.9, 1);
      expect(model.error).toBeLessThan(0.01);
      expect(model.firstHalfShare).toBe(0.45);
    }
  });

  it('needs a 1X2 market', () => {
    expect(fitFootballModel(pricesFor(1.2, 1.2).slice(1))).toBeNull();
  });

  it('spreads probability over every half-by-half scoreline', () => {
    const states = scoreStates({ home: 1.5, away: 1.2, firstHalfShare: 0.45, error: 0 });
    expect(states.reduce((s, x) => s + x.p, 0)).toBeCloseTo(1, 6);
  });
});

describe('priceBuilder', () => {
  const model = { home: 1.7, away: 0.9, firstHalfShare: 0.45, error: 0 };
  const leg = (
    marketType: Parameters<typeof priceBuilder>[1][number]['marketType'],
    line: number | null,
    outcome: Parameters<typeof priceBuilder>[1][number]['outcome'],
    oddsMilli: number,
  ) => ({ marketType, line, outcome, oddsMilli });

  it('prices correlated legs below the product of their prices', () => {
    const price = priceBuilder(model, [
      leg('MATCH_RESULT', null, 'HOME', 1_700),
      leg('TOTAL_GOALS', 2.5, 'OVER', 1_900),
    ]);
    expect(price.ok).toBe(true);
    if (!price.ok) return;
    const states = scoreStates(model);
    const p = combinationProbability(states, [
      { marketType: 'MATCH_RESULT', line: null, outcome: 'HOME' },
      { marketType: 'TOTAL_GOALS', line: 2.5, outcome: 'OVER' },
    ]).win;
    expect(price.probability).toBeCloseTo(p, 10);
    // Fair price less 8 %, cut to two decimals — and never above 1.70 × 1.90.
    expect(price.oddsMilli).toBe(Math.floor(100 / p / 1.08) * 10);
    expect(price.oddsMilli).toBeLessThan(1_700 * 1.9);
    expect(price.oddsMilli % 10).toBe(0);
  });

  it('never pays more than the legs multiplied', () => {
    const price = priceBuilder(
      model,
      [leg('MATCH_RESULT', null, 'AWAY', 1_050), leg('HALF_TIME_RESULT', null, 'HOME', 1_050)],
      0,
    );
    // A contradictory-looking but possible pair priced by the model far above
    // 1.05 × 1.05 is capped at that product.
    expect(price).toEqual({ ok: true, oddsMilli: 1_100, probability: expect.any(Number) });
  });

  it('refuses combinations that cannot win and markets it does not price', () => {
    expect(
      priceBuilder(model, [
        leg('TOTAL_GOALS', 2.5, 'OVER', 1_900),
        leg('TOTAL_GOALS', 1.5, 'UNDER', 2_500),
      ]),
    ).toEqual({ ok: false, message: 'Diese Kombination kann nicht gewinnen.' });
    expect(
      priceBuilder(model, [
        leg('MATCH_RESULT', null, 'HOME', 1_700),
        leg('TOTAL_CORNERS', 9.5, 'OVER', 1_900),
      ]).ok,
    ).toBe(false);
    expect(
      priceBuilder(model, [
        leg('TOTAL_GOALS', 2.5, 'OVER', 1_900),
        leg('TOTAL_GOALS', 2.5, 'UNDER', 1_900),
      ]),
    ).toEqual({ ok: false, message: 'Pro Markt ist nur eine Auswahl möglich.' });
  });

  it('prices a void leg as stake back', () => {
    // Draw no bet on the home side with a 0:0-excluding leg: a draw voids it.
    const legs = [
      { marketType: 'DRAW_NO_BET' as const, line: null, outcome: 'HOME' as const },
      { marketType: 'BOTH_TEAMS_TO_SCORE' as const, line: null, outcome: 'YES' as const },
    ];
    const { win, void: voided } = combinationProbability(scoreStates(model), legs);
    expect(voided).toBeGreaterThan(0.05);
    const price = priceBuilder(
      model,
      legs.map((l) => ({ ...l, oddsMilli: 9_000 })),
      0,
    );
    expect(price.ok && price.oddsMilli).toBe(Math.floor(((1 - voided) / win) * 100) * 10);
  });
});

describe('decideBuilder', () => {
  const won = { odds: 1_500, result: 'WON' as const };
  it('pays the builder price only when every leg wins', () => {
    expect(decideBuilder(1_000n, 3_450n, [won, won])).toEqual({
      decided: true,
      status: 'WON',
      payout: 3_450n,
      settledOddsMilli: 3_450n,
    });
  });
  it('loses on any lost leg, waits for pending ones, voids on a void leg', () => {
    expect(decideBuilder(1_000n, 3_450n, [won, { odds: 1_500, result: 'LOST' }]).decided).toBe(
      true,
    );
    expect(
      decideBuilder(1_000n, 3_450n, [
        { odds: 1, result: 'PENDING' },
        { odds: 1, result: 'LOST' },
      ]),
    ).toMatchObject({ status: 'LOST', payout: 0n });
    expect(decideBuilder(1_000n, 3_450n, [won, { odds: 1_500, result: 'PENDING' }])).toEqual({
      decided: false,
    });
    expect(decideBuilder(1_000n, 3_450n, [won, { odds: 1_500, result: 'VOID' }])).toMatchObject({
      status: 'VOID',
      payout: 1_000n,
    });
  });
});

describe('evaluateSlip in BUILDER mode', () => {
  const limits = {
    minStake: 10,
    maxStake: 1_000_000,
    maxPayout: 25_000_000,
    maxSelections: 20,
    maxTotalOdds: 10_000,
    acceptHigherMaxPct: 10,
  };
  const now = new Date('2026-09-29T12:00:00Z');
  const sel = (id: string, overrides: Partial<BookSelection> = {}): BookSelection => ({
    selectionId: id,
    selectionName: id,
    outcome: 'HOME',
    selectionStatus: 'OPEN',
    oddsMilli: 1_700,
    oddsVersion: 1,
    marketId: `m-${id}`,
    marketName: 'Ergebnis (1X2)',
    marketType: 'MATCH_RESULT',
    line: null,
    marketStatus: 'OPEN',
    marketTradingSuspended: false,
    eventId: 'e-1',
    eventName: 'A – B',
    eventStatus: 'SCHEDULED',
    eventIsActive: true,
    eventTradingSuspended: false,
    startTime: new Date('2026-09-30T18:00:00Z'),
    homeScore: null,
    awayScore: null,
    provider: 'mock',
    ...overrides,
  });
  const bookOf = (...items: BookSelection[]) => new Map(items.map((b) => [b.selectionId, b]));
  const over = sel('b', {
    outcome: 'OVER',
    marketType: 'TOTAL_GOALS',
    line: 2.5,
    marketName: 'Tore Über/Unter 2.5',
  });
  const request = (requestedOddsMilli?: number) => ({
    mode: 'BUILDER' as const,
    stake: 1_000n,
    requestedOddsMilli,
    policy: 'REJECT' as const,
    legs: [
      { selectionId: 'a', requestedOddsMilli: 0 },
      { selectionId: 'b', requestedOddsMilli: 0 },
    ],
  });
  const price = { ok: true as const, oddsMilli: 2_600, probability: 0.36 };

  it('books one BET_BUILDER bet at the model price', () => {
    const result = evaluateSlip(request(2_600), bookOf(sel('a'), over), {
      now,
      limits,
      requireStake: true,
      builder: price,
    });
    expect(result.issues).toEqual([]);
    expect(result.betType).toBe('BET_BUILDER');
    expect(result.totalOddsMilli).toBe(2_600n);
    expect(result.potentialReturn).toBe(2_600n);
  });

  it('flags a moved builder price and never re-prices leg by leg', () => {
    const result = evaluateSlip(request(2_700), bookOf(sel('a', { oddsMilli: 1_900 }), over), {
      now,
      limits,
      requireStake: true,
      builder: price,
    });
    expect(result.issues.map((i) => [i.code, i.currentOdds])).toEqual([['ODDS_CHANGED', 2.6]]);
  });

  it('rejects legs from two matches, live matches and missing prices', () => {
    const other = evaluateSlip(request(), bookOf(sel('a'), { ...over, eventId: 'e-2' }), {
      now,
      limits,
      requireStake: false,
      builder: price,
    });
    expect(other.issues[0]?.message).toContain('demselben Spiel');
    expect(other.bets).toEqual([]);

    const live = evaluateSlip(request(), bookOf(sel('a', { eventStatus: 'LIVE' }), over), {
      now,
      limits,
      requireStake: false,
      builder: price,
    });
    expect(live.issues.some((i) => i.message.includes('vor Spielbeginn'))).toBe(true);

    const none = evaluateSlip(request(), bookOf(sel('a'), over), {
      now,
      limits,
      requireStake: false,
    });
    expect(none.issues[0]?.message).toContain('kein Bet Builder');
  });
});
