import {
  combinationProbability,
  fitFootballModel,
  MAX_MODEL_ERROR,
  periodStates,
  type FootballModel,
  type ModelMarket,
  type ScoreState,
} from '@storm-bet/betting-engine';
import {
  formatLine,
  marketKey,
  MARKET_DEFINITIONS,
  type MarketPeriod,
  type MarketType,
  type Outcome,
  type SportKey,
} from '@storm-bet/types';
import { isOffered, MARGINS, normalCdf, priceOutcomes, priceSingle } from '../mock/pricing';
import type { ProviderMarket } from '../provider';
import { buildMarket, type MarketGate, type RawMarket } from './shared';

/**
 * Extra pre-match football markets for real feeds, priced from a goal model
 * fitted to the feed's own 1X2 and over/under prices (see football-model).
 * A market the feed quotes itself is never replaced, and nothing is derived
 * when the model does not reproduce the feed's prices closely.
 */
const DERIVED: { type: MarketType; lines: (number | null)[]; margin: number }[] = [
  { type: 'DOUBLE_CHANCE', lines: [null], margin: MARGINS.main / 2 },
  { type: 'DRAW_NO_BET', lines: [null], margin: MARGINS.main },
  { type: 'BOTH_TEAMS_TO_SCORE', lines: [null], margin: MARGINS.props },
  { type: 'TOTAL_GOALS', lines: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5], margin: MARGINS.totals },
  { type: 'ASIAN_HANDICAP', lines: [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5], margin: MARGINS.totals },
  { type: 'HALF_TIME_RESULT', lines: [null], margin: MARGINS.props },
  { type: 'FIRST_HALF_TOTAL_GOALS', lines: [0.5, 1.5, 2.5], margin: MARGINS.props },
  { type: 'SECOND_HALF_RESULT', lines: [null], margin: MARGINS.props },
  { type: 'SECOND_HALF_TOTAL_GOALS', lines: [0.5, 1.5, 2.5], margin: MARGINS.props },
];

const FIT_MARKETS = new Set<MarketType>([
  'MATCH_RESULT',
  'TOTAL_GOALS',
  'HALF_TIME_RESULT',
  'FIRST_HALF_TOTAL_GOALS',
]);
const MODEL_CACHE_SIZE = 500;
const models = new Map<string, FootballModel | null>();

function fitted(markets: ModelMarket[]): FootballModel | null {
  const key = JSON.stringify(markets);
  if (models.has(key)) return models.get(key)!;
  const model = fitFootballModel(markets);
  const usable = model && model.error <= MAX_MODEL_ERROR ? model : null;
  if (models.size >= MODEL_CACHE_SIZE) models.delete(models.keys().next().value!);
  models.set(key, usable);
  return usable;
}

function selectionName(
  outcome: Outcome,
  line: number | null,
  handicap: boolean,
  names: { home: string; away: string },
): string {
  const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);
  switch (outcome) {
    case 'HOME':
      return handicap && line != null ? `${names.home} ${signed(line)}` : names.home;
    case 'AWAY':
      return handicap && line != null ? `${names.away} ${signed(-line)}` : names.away;
    case 'DRAW':
      return 'Unentschieden';
    case 'HOME_OR_DRAW':
      return `${names.home} oder Unentschieden`;
    case 'HOME_OR_AWAY':
      return `${names.home} oder ${names.away}`;
    case 'DRAW_OR_AWAY':
      return `Unentschieden oder ${names.away}`;
    case 'OVER':
      return `Über ${line}`;
    case 'UNDER':
      return `Unter ${line}`;
    case 'YES':
      return 'Ja';
    case 'NO':
      return 'Nein';
    default:
      return outcome;
  }
}

/** Derived markets for one pre-match football event; only when the gate is open. */
export function deriveFootballMarkets(
  feed: readonly ProviderMarket[],
  names: { home: string; away: string },
  gate: MarketGate,
  /** Only a feed that reports half-time scores can settle half markets. */
  options: { halves: boolean },
): ProviderMarket[] {
  if (gate.status !== 'OPEN') return [];
  const model = fitted(
    feed
      .filter((m) => m.status === 'OPEN' && FIT_MARKETS.has(m.type))
      .map((m) => ({
        type: m.type,
        line: m.line,
        selections: m.selections.map((s) => ({ outcome: s.outcome, odds: s.odds })),
      })),
  );
  if (!model) return [];

  const cache = new Map<MarketPeriod, ScoreState[]>();
  const statesFor = (period: MarketPeriod) => {
    let states = cache.get(period);
    if (!states) {
      states = periodStates(model, period);
      cache.set(period, states);
    }
    return states;
  };
  const offered = new Set(feed.map((m) => m.key));
  const out: ProviderMarket[] = [];
  for (const { type, lines, margin } of DERIVED) {
    const definition = MARKET_DEFINITIONS[type];
    if (definition.period !== 'FULL' && !options.halves) continue;
    for (const line of lines) {
      const key = marketKey(type, line);
      if (offered.has(key)) continue;
      const states = statesFor(definition.period);
      // Probability of winning among decided outcomes (a push returns the stake).
      const probabilities = definition.outcomes.map((outcome) => {
        const p = combinationProbability(states, [{ marketType: type, line, outcome }]);
        return p.void < 1 ? p.win / (1 - p.void) : 0;
      });
      if (!probabilities.every(isOffered)) continue;
      const odds =
        definition.kind === 'DOUBLE_CHANCE'
          ? probabilities.map((p) => priceSingle(p, margin))
          : priceOutcomes(probabilities, margin);
      const handicap = definition.kind === 'HANDICAP';
      out.push({
        key,
        type,
        name: line == null ? definition.label : `${definition.label} ${formatLine(line, handicap)}`,
        line,
        status: 'OPEN',
        suspensionReason: null,
        derived: true,
        selections: definition.outcomes.map((outcome, i) => ({
          key: outcome,
          name: selectionName(outcome, line, handicap, names),
          outcome,
          odds: odds[i]!,
          status: 'OPEN',
          playerExternalId: null,
        })),
      });
    }
  }
  return out;
}

/**
 * Alternative lines around the feed's main total and handicap in sports
 * with high, near-normal scores: the margin of victory and the total are
 * taken as normal around the values the feed's fair prices imply.
 */
const LADDERS: Partial<Record<SportKey, { total: number; spread: number; steps: number[] }>> = {
  basketball: { total: 17, spread: 12, steps: [-10, -5, 5, 10] },
  american_football: { total: 13, spread: 13, steps: [-7, -3, 3, 7] },
};

/** Inverse of the standard normal distribution (bisection is plenty here). */
function probit(p: number): number {
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function deriveLineLadder(
  feed: readonly ProviderMarket[],
  names: { home: string; away: string },
  gate: MarketGate,
  sport: SportKey,
): ProviderMarket[] {
  const ladder = LADDERS[sport];
  if (!ladder || gate.status !== 'OPEN') return [];
  const offered = new Set(feed.map((m) => m.key));
  const fairFirst = (m: ProviderMarket, outcome: string) => {
    const [a, b] = m.selections;
    if (!a || !b) return null;
    const p = 1 / a.odds / (1 / a.odds + 1 / b.odds);
    return a.outcome === outcome ? p : 1 - p;
  };
  const out: ProviderMarket[] = [];
  const add = (type: MarketType, raw: RawMarket) => {
    const market = buildMarket(type, raw, names, gate, sport);
    if (market && !offered.has(market.key)) out.push({ ...market, derived: true });
  };
  const total = feed.find((m) => m.type === 'TOTAL_POINTS' && !m.derived && m.line !== null);
  const totalOver = total ? fairFirst(total, 'OVER') : null;
  if (total && totalOver !== null) {
    const mean = total.line! + ladder.total * probit(totalOver);
    for (const step of ladder.steps) {
      const line = total.line! + step;
      if (line <= 0) continue;
      const over = 1 - normalCdf((line - mean) / ladder.total);
      if (!isOffered(over)) continue;
      const [o, u] = priceOutcomes([over, 1 - over], MARGINS.totals);
      add('TOTAL_POINTS', { kind: 'TOTAL', line, over: o!, under: u! });
    }
  }
  const spread = feed.find((m) => m.type === 'POINT_SPREAD' && !m.derived && m.line !== null);
  const covers = spread ? fairFirst(spread, 'HOME') : null;
  if (spread && covers !== null) {
    // Home covers when margin + line > 0.
    const margin = ladder.spread * probit(covers) - spread.line!;
    for (const step of ladder.steps) {
      const line = spread.line! + step;
      const home = normalCdf((margin + line) / ladder.spread);
      if (!isOffered(home)) continue;
      const [h, a] = priceOutcomes([home, 1 - home], MARGINS.totals);
      add('POINT_SPREAD', { kind: 'HANDICAP', line, home: h!, away: a! });
    }
  }
  return out;
}
