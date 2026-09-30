import {
  MARKET_DEFINITIONS,
  type EventStatistics,
  type EventStatus,
  type MarketPeriod,
  type MarketType,
  type Outcome,
  type Pair,
  type PlayerStat,
  type PlayerStatLine,
  type SelectionResult,
} from '@storm-bet/types';
import { combinations } from './system';

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
    default:
      if (which === 'score') return stats.score;
  }
  throw new SettlementDataError(`metric "${which}" is not recorded for ${stats.sport}`);
}

/** The score of one half; only 'score' is recorded per half. */
function halfScore(stats: EventStatistics, period: 'H1' | 'H2'): Pair {
  if (stats.sport === 'football') {
    const first = stats.firstHalf;
    if (period === 'H1' && first) return first;
    if (period === 'H2') {
      if (stats.secondHalf) return stats.secondHalf;
      if (first && first.home <= stats.goals.home && first.away <= stats.goals.away)
        return { home: stats.goals.home - first.home, away: stats.goals.away - first.away };
    }
  }
  if (stats.sport === 'basketball' && period === 'H1') {
    if (stats.firstHalf) return stats.firstHalf;
    const [q1, q2] = stats.periods;
    // periods holds quarters only when there are at least four of them.
    if (q1 && q2 && stats.periods.length >= 4)
      return { home: q1.home + q2.home, away: q1.away + q2.away };
  }
  throw new SettlementDataError(`${period} score is not recorded for ${stats.sport}`);
}

function resultFigure(
  stats: EventStatistics,
  which: 'score' | 'corners' | 'cards' | 'games',
  period: MarketPeriod,
): Pair {
  if (period === 'FULL') return metric(stats, which);
  if (which !== 'score') throw new SettlementDataError(`${which} is not recorded per half`);
  return halfScore(stats, period);
}

/**
 * A player's figure, or null when the player did not play (missing from a
 * recorded list — the bet is then void). No recorded list at all, or a
 * recorded player without this figure, cannot be settled automatically.
 */
function playerFigure(
  players: PlayerStatLine[] | undefined,
  playerId: string,
  stat: PlayerStat,
): number | null {
  if (!players) throw new SettlementDataError('player figures were not recorded');
  const line = players.find((p) => p.playerId === playerId);
  if (!line) return null;
  if (stat === 'pra') {
    const { points, rebounds, assists } = line.stats;
    if (points === undefined || rebounds === undefined || assists === undefined)
      throw new SettlementDataError('points, rebounds or assists not recorded for a player');
    return points + rebounds + assists;
  }
  const value = line.stats[stat];
  if (value === undefined) throw new SettlementDataError(`${stat} not recorded for a player`);
  return value;
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
  if (definition.kind === 'PLAYER_TOTAL') {
    if ((stats.sport !== 'football' && stats.sport !== 'basketball') || !definition.playerStat) {
      throw new SettlementDataError(`${selection.marketType} has no player figures`);
    }
    if (!selection.playerId) throw new SettlementDataError('player market without a player');
    if (selection.line == null) throw new SettlementDataError('player total without a line');
    const figure = playerFigure(stats.players, selection.playerId, definition.playerStat);
    if (figure === null || figure === selection.line) return 'VOID';
    if (outcome === 'OVER') return won(figure > selection.line);
    if (outcome === 'UNDER') return won(figure < selection.line);
    throw new SettlementDataError(`outcome ${outcome} does not belong to ${selection.marketType}`);
  }
  const value = resultFigure(stats, definition.metric, definition.period);

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
      if (stats.players) {
        // Official stat lines: a player who did not play is a non-runner (void).
        const goals = playerFigure(stats.players, selection.playerId, 'goals');
        return goals === null ? 'VOID' : won(goals > 0);
      }
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

/**
 * Outcome of a Bet Builder: one price for legs on one match. A lost leg loses
 * it; otherwise every leg must be resulted. Its price holds only for all legs
 * together, so a void leg voids the whole bet (stake returned) instead of
 * being counted at 1.00 as in a multiple.
 */
export function decideBuilder(
  stake: bigint,
  oddsMilli: bigint,
  legs: readonly LegResult[],
): BetOutcome {
  if (legs.some((l) => l.result === 'LOST')) {
    return { decided: true, status: 'LOST', payout: 0n, settledOddsMilli: null };
  }
  if (legs.some((l) => l.result === 'PENDING')) return { decided: false };
  if (legs.length === 0 || legs.some((l) => l.result === 'VOID'))
    return { decided: true, status: 'VOID', payout: stake, settledOddsMilli: null };
  return {
    decided: true,
    status: 'WON',
    payout: (stake * oddsMilli) / 1000n,
    settledOddsMilli: oddsMilli,
  };
}

/**
 * Outcome of a system bet: `stake` is spread evenly over every combination of
 * `size` legs, and each combination is settled like a multiple (void legs at
 * 1.00, a lost leg loses that combination). Decided early only when so many
 * legs lost that no combination can win; otherwise when every leg is resulted.
 * It is won when anything is paid (even less than the stake), void when every
 * leg is void.
 */
export function decideSystem(stake: bigint, size: number, legs: readonly LegResult[]): BetOutcome {
  const n = legs.length;
  const lines = combinations(n, size);
  const lost = legs.filter((l) => l.result === 'LOST').length;
  if (lines.length === 0 || lost > n - size) {
    return { decided: true, status: 'LOST', payout: 0n, settledOddsMilli: null };
  }
  if (legs.some((l) => l.result === 'PENDING')) return { decided: false };
  if (legs.every((l) => l.result === 'VOID')) {
    return { decided: true, status: 'VOID', payout: stake, settledOddsMilli: null };
  }
  const unit = stake / BigInt(lines.length);
  let payout = 0n;
  for (const combo of lines) {
    const picked = combo.map((i) => legs[i]!);
    if (picked.some((l) => l.result === 'LOST')) continue;
    let product = 1n;
    for (const leg of picked) product *= BigInt(leg.result === 'WON' ? leg.odds : 1000);
    // Truncated like the combination's odds at placement.
    payout += (unit * (product / 1000n ** BigInt(size - 1))) / 1000n;
  }
  if (payout === 0n) return { decided: true, status: 'LOST', payout: 0n, settledOddsMilli: null };
  return {
    decided: true,
    status: 'WON',
    payout,
    settledOddsMilli: (payout * 1000n) / stake,
  };
}
