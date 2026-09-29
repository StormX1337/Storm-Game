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
} from '@storm-bet/types';
import { isOffered, MARGINS, priceOutcomes, priceSingle } from '../mock/pricing';
import type { ProviderMarket } from '../provider';
import type { MarketGate } from './shared';

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
