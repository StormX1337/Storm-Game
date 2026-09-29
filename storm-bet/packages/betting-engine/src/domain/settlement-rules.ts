import {
  MARKET_DEFINITIONS,
  type EventStatistics,
  type EventStatus,
  type MarketType,
  type Outcome,
  type Pair,
  type SelectionResult,
} from '@storm-bet/types';

export class SettlementDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementDataError';
  }
}

export interface SelectionToResolve {
  marketType: MarketType;
  line: number | null;
  outcome: Outcome;
  playerId: string | null;
}

function metric(stats: EventStatistics, which: 'score' | 'corners' | 'cards' | 'games'): Pair {
  switch (stats.sport) {
    case 'football':
      if (which === 'score') return stats.goals;
      if (which === 'corners' && stats.corners) return stats.corners;
      if (which === 'cards' && stats.yellowCards && stats.redCards) {
        return {
          home: stats.yellowCards.home + stats.redCards.home,
          away: stats.yellowCards.away + stats.redCards.away,
        };
      }
      break;
    case 'tennis':
      if (which === 'score') return stats.setsWon;
      if (which === 'games' && stats.sets.length > 0) {
        return stats.sets.reduce(
          (acc, set) => ({ home: acc.home + set.home, away: acc.away + set.away }),
          { home: 0, away: 0 },
        );
      }
      break;
    case 'basketball':
      if (which === 'score') return stats.points;
      break;
  }
  throw new SettlementDataError(`metric "${which}" is not recorded for ${stats.sport}`);
}

const won = (condition: boolean): SelectionResult => (condition ? 'WON' : 'LOST');

/**
 * Decides one selection from the official result. Pure and total over the
 * market catalogue: every market type the book offers has exactly one rule
 * here, keyed by the same definition the pricing used.
 *
 * - A cancelled event voids everything.
 * - Whole-number lines that land exactly are a push (VOID, stake returned).
 */
export function resolveSelection(
  selection: SelectionToResolve,
  eventStatus: EventStatus,
  stats: EventStatistics | null,
): SelectionResult {
  if (eventStatus === 'CANCELLED') return 'VOID';
  if (eventStatus !== 'FINISHED') {
    throw new SettlementDataError(`event is ${eventStatus}, not finished`);
  }
  if (!stats) throw new SettlementDataError('no official statistics recorded');
  const definition = MARKET_DEFINITIONS[selection.marketType];
  if (!definition.sports.includes(stats.sport)) {
    throw new SettlementDataError(
      `${selection.marketType} cannot be settled from ${stats.sport} statistics`,
    );
  }
  const { outcome } = selection;
  const value = metric(stats, definition.metric);

  switch (definition.kind) {
    case 'THREE_WAY':
      if (outcome === 'HOME') return won(value.home > value.away);
      if (outcome === 'DRAW') return won(value.home === value.away);
      if (outcome === 'AWAY') return won(value.home < value.away);
      break;
    case 'DOUBLE_CHANCE':
      if (outcome === 'HOME_OR_DRAW') return won(value.home >= value.away);
      if (outcome === 'HOME_OR_AWAY') return won(value.home !== value.away);
      if (outcome === 'DRAW_OR_AWAY') return won(value.home <= value.away);
      break;
    case 'DRAW_NO_BET':
    case 'TWO_WAY':
      if (value.home === value.away) return 'VOID';
      if (outcome === 'HOME') return won(value.home > value.away);
      if (outcome === 'AWAY') return won(value.away > value.home);
      break;
    case 'TOTAL': {
      if (selection.line == null) throw new SettlementDataError('total market without a line');
      const total = value.home + value.away;
      if (total === selection.line) return 'VOID';
      if (outcome === 'OVER') return won(total > selection.line);
      if (outcome === 'UNDER') return won(total < selection.line);
      break;
    }
    case 'HANDICAP': {
      if (selection.line == null) throw new SettlementDataError('handicap market without a line');
      // The line is the home side's handicap.
      const margin = value.home + selection.line - value.away;
      if (margin === 0) return 'VOID';
      if (outcome === 'HOME') return won(margin > 0);
      if (outcome === 'AWAY') return won(margin < 0);
      break;
    }
    case 'BOTH_SCORE':
      if (outcome === 'YES') return won(value.home > 0 && value.away > 0);
      if (outcome === 'NO') return won(value.home === 0 || value.away === 0);
      break;
    case 'PLAYER_SCORES': {
      if (stats.sport !== 'football') break;
      if (!selection.playerId) throw new SettlementDataError('player market without a player');
      if (!stats.goalEvents) throw new SettlementDataError('goal scorers were not recorded');
      return won(stats.goalEvents.some((g) => g.playerId === selection.playerId));
    }
    case 'FIRST_SET': {
      if (stats.sport !== 'tennis') break;
      const first = stats.sets[0];
      if (!first || first.home === first.away)
        throw new SettlementDataError('first set not recorded');
      if (outcome === 'HOME') return won(first.home > first.away);
      if (outcome === 'AWAY') return won(first.away > first.home);
      break;
    }
    case 'SET_SCORE': {
      const s = value;
      if (outcome === 'SETS_2_0') return won(s.home === 2 && s.away === 0);
      if (outcome === 'SETS_2_1') return won(s.home === 2 && s.away === 1);
      if (outcome === 'SETS_1_2') return won(s.home === 1 && s.away === 2);
      if (outcome === 'SETS_0_2') return won(s.home === 0 && s.away === 2);
      break;
    }
  }
  throw new SettlementDataError(`outcome ${outcome} does not belong to ${selection.marketType}`);
}

export interface LegResult {
  odds: number;
  result: SelectionResult;
}

export type BetOutcome =
  | { decided: false }
  | {
      decided: true;
      status: 'WON' | 'LOST' | 'VOID';
      payout: bigint;
      settledOddsMilli: bigint | null;
    };

/**
 * Outcome of a bet from its legs. A single lost leg decides a multiple at
 * once; otherwise every leg must be resulted. Void legs count at odds 1.00,
 * and a bet whose legs are all void is void (stake returned).
 */
export function decideBet(stake: bigint, legs: readonly LegResult[]): BetOutcome {
  if (legs.some((l) => l.result === 'LOST')) {
    return { decided: true, status: 'LOST', payout: 0n, settledOddsMilli: null };
  }
  if (legs.some((l) => l.result === 'PENDING')) return { decided: false };
  const winning = legs.filter((l) => l.result === 'WON');
  if (winning.length === 0)
    return { decided: true, status: 'VOID', payout: stake, settledOddsMilli: null };
  let product = 1n;
  for (const leg of winning) product *= BigInt(leg.odds);
  const settledOddsMilli = product / 1000n ** BigInt(winning.length - 1);
  return {
    decided: true,
    status: 'WON',
    payout: (stake * settledOddsMilli) / 1000n,
    settledOddsMilli,
  };
}
