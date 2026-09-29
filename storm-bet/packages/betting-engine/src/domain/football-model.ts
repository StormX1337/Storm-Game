import type {
  FootballStatistics,
  MarketPeriod,
  MarketType,
  Outcome,
  Pair,
  SelectionResult,
} from '@storm-bet/types';
import { MARKET_DEFINITIONS } from '@storm-bet/types';
import { combineOdds } from './odds';
import { resolveSelection } from './settlement-rules';

/**
 * A goal model for one football match, calibrated to the book's own prices.
 *
 * Each team's goals in each half are independent Poisson counts. The two
 * full-time rates are fitted to the margin-free 1X2 and over/under prices of
 * the feed, the first-half share to first-half prices when the feed has them.
 * The model prices what the feed does not quote itself: combinations of
 * selections on one match (Bet Builder) and extra lines. Every probability is
 * evaluated with the settlement rule that later decides the bet, so a market
 * cannot be priced one way and settled another.
 */

export interface ModelMarket {
  type: MarketType;
  line: number | null;
  selections: readonly { outcome: Outcome; odds: number }[];
}

export interface FootballModel {
  /** Expected full-time goals. */
  home: number;
  away: number;
  /** Share of the goals expected in the first half. */
  firstHalfShare: number;
  /** Root-mean-square gap between the model and the feed's fair probabilities. */
  error: number;
}

export interface ModelLeg {
  marketType: MarketType;
  line: number | null;
  outcome: Outcome;
}

/** A model that misses the feed's own prices by more than this is not used. */
export const MAX_MODEL_ERROR = 0.035;
/** Markets the model can price and combine: football score markets only. */
export const MODEL_MARKETS: ReadonlySet<MarketType> = new Set<MarketType>([
  'MATCH_RESULT',
  'DOUBLE_CHANCE',
  'DRAW_NO_BET',
  'TOTAL_GOALS',
  'ASIAN_HANDICAP',
  'BOTH_TEAMS_TO_SCORE',
  'HALF_TIME_RESULT',
  'FIRST_HALF_HANDICAP',
  'FIRST_HALF_TOTAL_GOALS',
  'SECOND_HALF_RESULT',
  'SECOND_HALF_TOTAL_GOALS',
]);

const DEFAULT_FIRST_HALF_SHARE = 0.45;
const MAX_GOALS = 15;
const MAX_HALF_GOALS = 8;

function pmf(lambda: number, maxK: number): number[] {
  const out: number[] = [];
  let p = Math.exp(-lambda);
  for (let k = 0; k <= maxK; k += 1) {
    out.push(p);
    p = (p * lambda) / (k + 1);
  }
  // The tail goes into the last bucket so the distribution sums to one.
  const sum = out.reduce((a, b) => a + b, 0);
  out[maxK] = (out[maxK] ?? 0) + Math.max(0, 1 - sum);
  return out;
}

/** Margin-free probabilities of a market's outcomes, in the given order. */
function fair(market: ModelMarket | undefined, outcomes: Outcome[]): number[] | null {
  if (!market) return null;
  const inverse = outcomes.map((o) => {
    const odds = market.selections.find((s) => s.outcome === o)?.odds;
    return odds && odds > 1 ? 1 / odds : null;
  });
  if (inverse.some((v) => v === null)) return null;
  const total = inverse.reduce<number>((a, b) => a + b!, 0);
  return inverse.map((v) => v! / total);
}

function totalTargets(markets: readonly ModelMarket[], type: MarketType) {
  return markets.flatMap((m) => {
    if (m.type !== type || m.line == null || m.line <= 0) return [];
    const f = fair(m, ['OVER', 'UNDER']);
    return f ? [{ line: m.line, over: f[0]! }] : [];
  });
}

/** P(over) among decided outcomes: a whole-number line that lands is void. */
function overShare(dist: number[], line: number): number {
  let over = 0;
  let under = 0;
  dist.forEach((p, k) => {
    if (k > line) over += p;
    else if (k < line) under += p;
  });
  return over + under > 0 ? over / (over + under) : 0;
}

function resultProbabilities(home: number[], away: number[]): [number, number, number] {
  let h = 0;
  let d = 0;
  let a = 0;
  home.forEach((ph, i) =>
    away.forEach((pa, j) => {
      const p = ph * pa;
      if (i > j) h += p;
      else if (i === j) d += p;
      else a += p;
    }),
  );
  return [h, d, a];
}

const squared = (xs: number[], ys: number[]) =>
  xs.reduce((sum, x, i) => sum + (x - ys[i]!) ** 2, 0);

function fitFirstHalfShare(markets: readonly ModelMarket[], home: number, away: number): number {
  const totals = totalTargets(markets, 'FIRST_HALF_TOTAL_GOALS');
  const result = fair(
    markets.find((m) => m.type === 'HALF_TIME_RESULT'),
    ['HOME', 'DRAW', 'AWAY'],
  );
  if (!totals.length && !result) return DEFAULT_FIRST_HALF_SHARE;
  let best = DEFAULT_FIRST_HALF_SHARE;
  let bestLoss = Infinity;
  for (let i = 0; i <= 60; i += 1) {
    const share = 0.3 + i * 0.005;
    let loss = 0;
    if (totals.length) {
      const dist = pmf((home + away) * share, MAX_GOALS);
      for (const t of totals) loss += (overShare(dist, t.line) - t.over) ** 2;
    }
    if (result) {
      const p = resultProbabilities(pmf(home * share, MAX_GOALS), pmf(away * share, MAX_GOALS));
      loss += squared(p, result);
    }
    if (loss < bestLoss) {
      bestLoss = loss;
      best = share;
    }
  }
  return best;
}

/**
 * Fits the model to a match's prices. Needs a 1X2 market; over/under lines
 * sharpen the goal expectation. Null when the prices are unusable.
 */
export function fitFootballModel(markets: readonly ModelMarket[]): FootballModel | null {
  const result = fair(
    markets.find((m) => m.type === 'MATCH_RESULT'),
    ['HOME', 'DRAW', 'AWAY'],
  );
  if (!result) return null;
  const totals = totalTargets(markets, 'TOTAL_GOALS');
  const cache = new Map<number, number[]>();
  const dist = (lambda: number) => {
    const key = Math.round(lambda * 10_000);
    let d = cache.get(key);
    if (!d) {
      d = pmf(key / 10_000, MAX_GOALS);
      cache.set(key, d);
    }
    return d;
  };
  const loss = (h: number, a: number) => {
    let sum = squared(resultProbabilities(dist(h), dist(a)), result);
    if (totals.length) {
      const all = dist(h + a);
      for (const t of totals) sum += (overShare(all, t.line) - t.over) ** 2;
    }
    return sum;
  };

  let best = { home: 1.4, away: 1.1, loss: Infinity };
  const search = (center: { home: number; away: number } | null, step: number, radius: number) => {
    const hs = center
      ? range(center.home - radius, center.home + radius, step)
      : range(0.1, 4.5, step);
    const as = center
      ? range(center.away - radius, center.away + radius, step)
      : range(0.1, 4.5, step);
    for (const h of hs)
      for (const a of as) {
        const l = loss(h, a);
        if (l < best.loss) best = { home: h, away: a, loss: l };
      }
  };
  search(null, 0.1, 0);
  search(best, 0.01, 0.1);
  search(best, 0.001, 0.01);

  const error = Math.sqrt(best.loss / (3 + totals.length));
  return {
    home: best.home,
    away: best.away,
    firstHalfShare: fitFirstHalfShare(markets, best.home, best.away),
    error,
  };
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  const n = Math.round((to - from) / step);
  for (let i = 0; i <= n; i += 1) {
    const v = Math.round((from + i * step) * 10_000) / 10_000;
    if (v >= 0.02) out.push(v);
  }
  return out;
}

/** One way the match can go, half by half. */
export interface ScoreState {
  firstHalf: Pair;
  secondHalf: Pair;
  p: number;
}

function states(first: [number, number], second: [number, number]): ScoreState[] {
  const [h1, a1] = first.map((l) => pmf(l, MAX_HALF_GOALS)) as [number[], number[]];
  const [h2, a2] = second.map((l) => pmf(l, MAX_HALF_GOALS)) as [number[], number[]];
  const out: ScoreState[] = [];
  h1.forEach((p1, i) =>
    a1.forEach((p2, j) =>
      h2.forEach((p3, k) =>
        a2.forEach((p4, l) => {
          const p = p1 * p2 * p3 * p4;
          if (p >= 1e-10)
            out.push({ firstHalf: { home: i, away: j }, secondHalf: { home: k, away: l }, p });
        }),
      ),
    ),
  );
  return out;
}

/** Every half-by-half scoreline with its probability. */
export function scoreStates(model: FootballModel): ScoreState[] {
  const s = model.firstHalfShare;
  return states([model.home * s, model.away * s], [model.home * (1 - s), model.away * (1 - s)]);
}

/**
 * Scorelines of one period only — enough (and much cheaper) for single
 * markets of that period. Legs of other periods must not be evaluated on them.
 */
export function periodStates(model: FootballModel, period: MarketPeriod): ScoreState[] {
  const share =
    period === 'FULL' ? 1 : period === 'H1' ? model.firstHalfShare : 1 - model.firstHalfShare;
  const rates: [number, number] = [model.home * share, model.away * share];
  const nothing: [number, number] = [0, 0];
  if (period === 'H2') return states(nothing, rates);
  // FULL and H1: the figures sit in the first half, the second half is 0:0.
  return states(rates, nothing);
}

function statistics(state: ScoreState): FootballStatistics {
  return {
    sport: 'football',
    goals: {
      home: state.firstHalf.home + state.secondHalf.home,
      away: state.firstHalf.away + state.secondHalf.away,
    },
    firstHalf: state.firstHalf,
    secondHalf: state.secondHalf,
  };
}

/**
 * Probability that every leg wins, and that the combination is void (no leg
 * lost, at least one void) — exactly how a Bet Builder is settled.
 */
export function combinationProbability(
  scoreStates: readonly ScoreState[],
  legs: readonly ModelLeg[],
): { win: number; void: number } {
  let mass = 0;
  let win = 0;
  let voided = 0;
  for (const state of scoreStates) {
    mass += state.p;
    const stats = statistics(state);
    let result: SelectionResult = 'WON';
    for (const leg of legs) {
      const r = resolveSelection({ ...leg, playerId: null }, 'FINISHED', stats);
      if (r === 'LOST') {
        result = 'LOST';
        break;
      }
      if (r === 'VOID') result = 'VOID';
    }
    if (result === 'WON') win += state.p;
    else if (result === 'VOID') voided += state.p;
  }
  return mass > 0 ? { win: win / mass, void: voided / mass } : { win: 0, void: 0 };
}

/** Bet Builder margin on the model's fair price; published on the rules page. */
export const BUILDER_MARGIN = 0.08;
export const BUILDER_MIN_LEGS = 2;
export const BUILDER_MAX_LEGS = 8;

export type BuilderPrice =
  | { ok: true; oddsMilli: number; probability: number }
  | { ok: false; message: string };

/**
 * The Bet Builder price of legs on one match: the model's fair price less the
 * margin, never above the product of the legs' own prices (a combination on
 * one match is never paid better than the same legs across matches), cut
 * down to two decimals.
 */
export function priceBuilder(
  model: FootballModel,
  legs: readonly (ModelLeg & { oddsMilli: number })[],
  margin = BUILDER_MARGIN,
): BuilderPrice {
  if (legs.some((l) => !MODEL_MARKETS.has(l.marketType))) {
    return { ok: false, message: 'Dieser Markt ist im Bet Builder nicht verfügbar.' };
  }
  const markets = new Set(legs.map((l) => `${l.marketType}:${l.line ?? ''}`));
  if (markets.size !== legs.length) {
    return { ok: false, message: 'Pro Markt ist nur eine Auswahl möglich.' };
  }
  const { win, void: voided } = combinationProbability(scoreStates(model), legs);
  if (win < 1e-4) return { ok: false, message: 'Diese Kombination kann nicht gewinnen.' };
  const fairOdds = (1 - voided) / win;
  const cap = Number(combineOdds(legs.map((l) => l.oddsMilli))) / 1000;
  const odds = Math.min(fairOdds / (1 + margin), cap);
  const oddsMilli = Math.floor(odds * 100 + 1e-9) * 10;
  if (oddsMilli < 1010) {
    return { ok: false, message: 'Diese Kombination ist praktisch sicher – keine Quote möglich.' };
  }
  return { ok: true, oddsMilli, probability: win };
}

/** The period a market type is decided on (for choosing its states). */
export function marketPeriod(type: MarketType): MarketPeriod {
  return MARKET_DEFINITIONS[type].period;
}
