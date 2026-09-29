import type {
  EventStatistics,
  EventStatus,
  LiveState,
  MarketStatus,
  MarketType,
  Outcome,
  Pair,
  SelectionStatus,
} from '@storm-bet/types';
import { MARKET_DEFINITIONS, formatLine, marketKey } from '@storm-bet/types';
import type { ProviderMarket, ProviderSelection, ProviderTeam } from '../provider';
import type { MockLeagueDef } from './catalog';
import { isOffered } from './pricing';

/** Everything a sport model needs to simulate one fixture. */
export interface MatchContext {
  seed: string;
  externalId: string;
  league: MockLeagueDef;
  home: ProviderTeam;
  away: ProviderTeam;
  /** Kick-off, epoch ms. */
  kickoff: number;
  /** Simulated minutes per real minute. */
  timeScale: number;
  /** A small share of fixtures is called off shortly before kick-off. */
  cancelled: boolean;
}

export interface MatchState {
  status: EventStatus;
  score: Pair | null;
  liveState: LiveState | null;
  statistics: EventStatistics | null;
  resultFinal: boolean;
  /** Set while the book is briefly closed (goal, red card …). */
  suspendedReason: string | null;
}

export interface SportModel<Plan> {
  plan(ctx: MatchContext): Plan;
  /** Simulated minutes from kick-off to the final whistle, breaks included. */
  totalGameMinutes(plan: Plan): number;
  state(ctx: MatchContext, plan: Plan, now: number): MatchState;
  markets(ctx: MatchContext, plan: Plan, state: MatchState, now: number): ProviderMarket[];
}

/** Simulated minutes elapsed since kick-off (negative before). */
export function gameMinutes(ctx: MatchContext, now: number): number {
  return ((now - ctx.kickoff) / 60_000) * ctx.timeScale;
}

export function preMatchState(): MatchState {
  return {
    status: 'SCHEDULED',
    score: null,
    liveState: { period: 'PRE', clock: null },
    statistics: null,
    resultFinal: false,
    suspendedReason: null,
  };
}

export function cancelledState(): MatchState {
  return {
    status: 'CANCELLED',
    score: null,
    liveState: null,
    statistics: null,
    resultFinal: true,
    suspendedReason: null,
  };
}

/** A priced outcome before it becomes a ProviderSelection. */
export interface Quote {
  outcome: Outcome;
  name: string;
  probability: number;
  odds: number;
  /** Set when the outcome is already decided in play. */
  decided?: boolean;
  playerExternalId?: string;
  key?: string;
}

/**
 * Turns quotes into a provider market, deriving statuses the same way for
 * every sport: finished → CLOSED, suspension window → SUSPENDED, outcomes
 * too (un)likely to price responsibly → not offered.
 */
export function buildMarket(
  type: MarketType,
  line: number | null,
  quotes: Quote[],
  state: MatchState,
  options: { closed?: boolean } = {},
): ProviderMarket {
  const definition = MARKET_DEFINITIONS[type];
  const over = state.status === 'FINISHED' || state.status === 'CANCELLED' || options.closed;
  const selections: ProviderSelection[] = quotes.map((q) => {
    let status: SelectionStatus = 'OPEN';
    // An outcome that can no longer happen (or is certain) is decided, not merely unpriced.
    if (over || q.decided || q.probability < 1e-9 || q.probability > 1 - 1e-9) status = 'CLOSED';
    else if (!isOffered(q.probability)) status = 'SUSPENDED';
    return {
      key: q.key ?? q.outcome,
      name: q.name,
      outcome: q.outcome,
      odds: q.odds,
      status,
      playerExternalId: q.playerExternalId ?? null,
    };
  });
  let status: MarketStatus = 'OPEN';
  if (over || selections.every((s) => s.status === 'CLOSED')) status = 'CLOSED';
  else if (state.suspendedReason || selections.every((s) => s.status !== 'OPEN')) {
    status = 'SUSPENDED';
  }
  return {
    key: marketKey(type, line),
    type,
    name:
      line == null
        ? definition.label
        : `${definition.label} ${formatLine(line, definition.kind === 'HANDICAP')}`,
    line,
    status,
    suspensionReason: status === 'SUSPENDED' ? state.suspendedReason : null,
    selections,
  };
}

/** Deterministic multiplicative noise so prices move between buckets like a real book. */
export function driftFactor(rngValue: number, spread: number): number {
  // Map a uniform draw to a symmetric factor in [1 - spread, 1 + spread].
  return 1 + (rngValue * 2 - 1) * spread;
}
