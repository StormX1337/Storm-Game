import type {
  FootballStatistics,
  MarketPeriod,
  MarketType,
  Outcome,
  Pair,
  SelectionResult,
} from '@storm-bet/types';
import { BUILDER_MARKETS, LIVE_BUILDER_MARKETS, MARKET_DEFINITIONS } from '@storm-bet/types';
import { combineOdds } from './odds';
import { resolveSelection } from './settlement-rules';

/**
 * A goal model for one football match, calibrated to the book's own prices.
 *
 * Each team's goals in each half are independent Poisson counts. The two
 * full-time rates are fitted to the margin-free 1X2 and over/under prices of
 * the feed, the first-half share to first-half prices when the feed has them.
 * In play the rates are those of the goals still to come, on top of the
 * current score. Corners and cards are separate Poisson counts fitted to
 * their own over/under prices; a goalscorer takes a share of his team's goals.
 * Every probability is evaluated with the settlement rule that later decides
 * the bet, so a market cannot be priced one way and settled another.
 */

export interface ModelMarket {
  type: MarketType;
  line: number | null;
  selections: readonly { outcome: Outcome; odds: number }[];
}

export interface FootballModel {
  /** Expected goals (still to come, in play). */
  home: number;
  away: number;
  /** Share of the goals expected in the first half. */
  firstHalfShare: number;
  /** Root-mean-square gap between the model and the feed's fair probabilities. */
  error: number;
  /** Score so far (0:0 before kick-off). */
  offset: Pair;
  /** Expected corners and cards, when the feed prices them. */
  corners: number | null;
  cards: number | null;
}

export interface ModelLeg {
  marketType: MarketType;
  line: number | null;
  outcome: Outcome;
  /** Goalscorer legs: the player's side and his anytime probability from the price. */
  player?: { side: 'HOME' | 'AWAY'; probability: number };
}

/** A model that misses the feed's own prices by more than this is not used. */
export const MAX_MODEL_ERROR = 0.035;
export const MODEL_MARKETS: ReadonlySet<MarketType> = new Set<MarketType>(BUILDER_MARKETS);
export const LIVE_MODEL_MARKETS: ReadonlySet<MarketType> = new Set<MarketType>(
  LIVE_BUILDER_MARKETS,
);

const DEFAULT_FIRST_HALF_SHARE = 0.45;
const MAX_GOALS = 15;
const MAX_HALF_GOALS = 8;
const MAX_COUNT = 60;
const NO_SCORE: Pair = { home: 0, away: 0 };

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
function overShare(dist: number[], line: number, already = 0): number {
  let over = 0;
  let under = 0;
  dist.forEach((p, k) => {
    if (k + already > line) over += p;
    else if (k + already < line) under += p;
  });
  return over + under > 0 ? over / (over + under) : 0;
}

function resultProbabilities(
  home: number[],
  away: number[],
  offset: Pair = NO_SCORE,
): [number, number, number] {
  let h = 0;
  let d = 0;
  let a = 0;
  home.forEach((ph, i) =>
    away.forEach((pa, j) => {
      const p = ph * pa;
      const diff = offset.home + i - (offset.away + j);
      if (diff > 0) h += p;
      else if (diff === 0) d += p;
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

/** Expected count of a counted figure (corners, cards) from its over/under prices. */
function fitCount(markets: readonly ModelMarket[], type: MarketType): number | null {
  const totals = totalTargets(markets, type);
  if (!totals.length) return null;
  let best = 0;
  let bestLoss = Infinity;
  for (let i = 1; i <= 600; i += 1) {
    const mean = i * 0.05;
    const dist = pmf(mean, MAX_COUNT);
    const loss = totals.reduce((sum, t) => sum + (overShare(dist, t.line) - t.over) ** 2, 0);
    if (loss < bestLoss) {
      bestLoss = loss;
      best = mean;
    }
  }
  return Math.sqrt(bestLoss / totals.length) <= MAX_MODEL_ERROR ? best : null;
}

/**
 * Fits the model to a match's prices. Needs a 1X2 market; over/under lines
 * sharpen the goal expectation. In play, `offset` is the current score and
 * the prices are the running ones. Null when the prices are unusable.
 */
export function fitFootballModel(
  markets: readonly ModelMarket[],
  inPlay?: Pair,
): FootballModel | null {
  const offset = inPlay ?? NO_SCORE;
  const result = fair(
    markets.find((m) => m.type === 'MATCH_RESULT'),
    ['HOME', 'DRAW', 'AWAY'],
  );
  if (!result) return null;
  const totals = totalTargets(markets, 'TOTAL_GOALS');
  const already = offset.home + offset.away;
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
    let sum = squared(resultProbabilities(dist(h), dist(a), offset), result);
    if (totals.length) {
      const all = dist(h + a);
      for (const t of totals) sum += (overShare(all, t.line, already) - t.over) ** 2;
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

  const live = inPlay !== undefined;
  return {
    home: best.home,
    away: best.away,
    firstHalfShare: live
      ? DEFAULT_FIRST_HALF_SHARE
      : fitFirstHalfShare(markets, best.home, best.away),
    error: Math.sqrt(best.loss / (3 + totals.length)),
    offset,
    corners: live ? null : fitCount(markets, 'TOTAL_CORNERS'),
    cards: live ? null : fitCount(markets, 'TOTAL_CARDS'),
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

/** One way the match can go, half by half (the first half includes the score so far). */
export interface ScoreState {
  firstHalf: Pair;
  secondHalf: Pair;
  p: number;
}

function states(
  first: [number, number],
  second: [number, number],
  offset: Pair = NO_SCORE,
): ScoreState[] {
  const [h1, a1] = first.map((l) => pmf(l, MAX_HALF_GOALS)) as [number[], number[]];
  const [h2, a2] = second.map((l) => pmf(l, MAX_HALF_GOALS)) as [number[], number[]];
  const out: ScoreState[] = [];
  h1.forEach((p1, i) =>
    a1.forEach((p2, j) =>
      h2.forEach((p3, k) =>
        a2.forEach((p4, l) => {
          const p = p1 * p2 * p3 * p4;
          if (p >= 1e-10)
            out.push({
              firstHalf: { home: offset.home + i, away: offset.away + j },
              secondHalf: { home: k, away: l },
              p,
            });
        }),
      ),
    ),
  );
  return out;
}

/** Every half-by-half scoreline with its probability. */
export function scoreStates(model: FootballModel): ScoreState[] {
  const s = model.firstHalfShare;
  return states(
    [model.home * s, model.away * s],
    [model.home * (1 - s), model.away * (1 - s)],
    model.offset,
  );
}

/**
 * Scorelines of one period only — enough (and much cheaper) for single
 * pre-match markets of that period. Legs of other periods must not be
 * evaluated on them.
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

/** WON, VOID or LOST for legs decided by the scoreline. */
function scoreResult(stats: FootballStatistics, legs: readonly ModelLeg[]): SelectionResult {
  let result: SelectionResult = 'WON';
  for (const leg of legs) {
    const r = resolveSelection(
      { marketType: leg.marketType, line: leg.line, outcome: leg.outcome, playerId: null },
      'FINISHED',
      stats,
    );
    if (r === 'LOST') return 'LOST';
    if (r === 'VOID') result = 'VOID';
  }
  return result;
}

/**
 * Probability that every leg wins, and that the combination is void (no leg
 * lost, at least one void) — exactly how a Bet Builder is settled. Scoreline
 * legs only (used for single derived markets as well).
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
    const result = scoreResult(statistics(state), legs);
    if (result === 'WON') win += state.p;
    else if (result === 'VOID') voided += state.p;
  }
  return mass > 0 ? { win: win / mass, void: voided / mass } : { win: 0, void: 0 };
}

/**
 * P(every listed player scores) when their team scores `goals`: each goal
 * goes to one player by his share (inclusion–exclusion over the players).
 */
function scorersFactor(shares: number[], goals: number): number {
  if (shares.length === 0) return 1;
  let total = 0;
  for (let mask = 0; mask < 1 << shares.length; mask += 1) {
    let sum = 0;
    let bits = 0;
    shares.forEach((s, i) => {
      if (mask & (1 << i)) {
        sum += s;
        bits += 1;
      }
    });
    total += (bits % 2 ? -1 : 1) * Math.max(0, 1 - sum) ** goals;
  }
  return Math.max(0, total);
}

/** A counted figure (corners, cards) as an independent part of a combination. */
function countPart(
  mean: number,
  legs: readonly ModelLeg[],
  stats: (count: number) => FootballStatistics,
): { win: number; void: number } {
  let win = 0;
  let voided = 0;
  pmf(mean, MAX_COUNT).forEach((p, count) => {
    const result = scoreResult(stats(count), legs);
    if (result === 'WON') win += p;
    else if (result === 'VOID') voided += p;
  });
  return { win, void: voided };
}

/** Win and void probability of a Bet Builder, or why it cannot be priced. */
export function builderProbability(
  model: FootballModel,
  legs: readonly ModelLeg[],
): { win: number; void: number } | { error: string } {
  const scorers = legs.filter((l) => l.marketType === 'PLAYER_TO_SCORE');
  const corners = legs.filter((l) => l.marketType === 'TOTAL_CORNERS');
  const cards = legs.filter((l) => l.marketType === 'TOTAL_CARDS');
  const goals = legs.filter(
    (l) => !scorers.includes(l) && !corners.includes(l) && !cards.includes(l),
  );
  if (corners.length && model.corners === null)
    return { error: 'Ecken sind für dieses Spiel nicht im Bet Builder verfügbar.' };
  if (cards.length && model.cards === null)
    return { error: 'Karten sind für dieses Spiel nicht im Bet Builder verfügbar.' };

  // A player's share of his team's goals, from his anytime price.
  const shares = { HOME: [] as number[], AWAY: [] as number[] };
  for (const leg of scorers) {
    if (!leg.player) return { error: 'Torschütze ohne Team.' };
    const rate = leg.player.side === 'HOME' ? model.home : model.away;
    const p = Math.min(0.97, Math.max(0.0001, leg.player.probability));
    shares[leg.player.side].push(Math.min(1, -Math.log(1 - p) / Math.max(rate, 0.05)));
  }

  let mass = 0;
  let win = 0;
  let voided = 0;
  for (const state of scoreStates(model)) {
    mass += state.p;
    const stats = statistics(state);
    const result = scoreResult(stats, goals);
    if (result === 'LOST') continue;
    const factor =
      scorersFactor(shares.HOME, stats.goals.home - model.offset.home) *
      scorersFactor(shares.AWAY, stats.goals.away - model.offset.away);
    if (result === 'WON') win += state.p * factor;
    else voided += state.p * factor;
  }
  const parts = [{ win: win / mass, void: voided / mass }];
  const base = { sport: 'football' as const, goals: NO_SCORE };
  if (corners.length)
    parts.push(
      countPart(model.corners!, corners, (c) => ({ ...base, corners: { home: c, away: 0 } })),
    );
  if (cards.length)
    parts.push(
      countPart(model.cards!, cards, (c) => ({
        ...base,
        yellowCards: { home: c, away: 0 },
        redCards: NO_SCORE,
      })),
    );
  // Independent parts: all must win; void when none is lost and one is void.
  const allWin = parts.reduce((p, x) => p * x.win, 1);
  const noneLost = parts.reduce((p, x) => p * (x.win + x.void), 1);
  return { win: allWin, void: noneLost - allWin };
}

/** Bet Builder margin on the model's fair price; published on the rules page. */
export const BUILDER_MARGIN = 0.08;
/** In play prices move faster; the published margin is higher. */
export const LIVE_BUILDER_MARGIN = 0.1;
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
  const markets = legs
    .filter((l) => l.marketType !== 'PLAYER_TO_SCORE')
    .map((l) => `${l.marketType}:${l.line ?? ''}`);
  if (new Set(markets).size !== markets.length) {
    return { ok: false, message: 'Pro Markt ist nur eine Auswahl möglich.' };
  }
  const probability = builderProbability(model, legs);
  if ('error' in probability) return { ok: false, message: probability.error };
  const { win, void: voided } = probability;
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
