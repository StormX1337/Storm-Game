import type { BettingLimits } from '@storm-bet/config';
import {
  ERROR_MESSAGES,
  type BetType,
  type ErrorCode,
  type EventStatus,
  type MarketStatus,
  type MarketType,
  type OddsChangePolicy,
  type Outcome,
  type SelectionStatus,
  type SlipMode,
} from '@storm-bet/types';
import { betTypeFor, combineOdds, fromMilli, maxStakeForPayout, potentialReturn } from './odds';

/** The book's current view of one selection, as loaded (and locked) from the database. */
export interface BookSelection {
  selectionId: string;
  selectionName: string;
  outcome: Outcome;
  selectionStatus: SelectionStatus;
  oddsMilli: number;
  oddsVersion: number;
  marketId: string;
  marketName: string;
  marketType: MarketType;
  line: number | null;
  marketStatus: MarketStatus;
  marketTradingSuspended: boolean;
  eventId: string;
  eventName: string;
  eventStatus: EventStatus;
  eventIsActive: boolean;
  eventTradingSuspended: boolean;
  startTime: Date;
  homeScore: number | null;
  awayScore: number | null;
  provider: string;
}

export interface SlipLegRequest {
  selectionId: string;
  requestedOddsMilli: number;
  /** SINGLES only. */
  stake?: bigint;
}

export interface SlipRequest {
  mode: SlipMode;
  legs: SlipLegRequest[];
  /** COMBO only. */
  stake?: bigint;
  policy: OddsChangePolicy;
}

export interface SlipIssue {
  code: ErrorCode;
  message: string;
  selectionId?: string;
  currentOdds?: number;
  requestedOdds?: number;
}

export interface PlannedLeg {
  book: BookSelection;
  /** The price the bet is accepted at: the book's current price. */
  oddsMilli: number;
}

export interface PlannedBet {
  type: BetType;
  legs: PlannedLeg[];
  stake: bigint;
  totalOddsMilli: bigint;
  potentialReturn: bigint;
}

export interface SlipEvaluation {
  issues: SlipIssue[];
  bets: PlannedBet[];
  betType: BetType | null;
  totalOddsMilli: bigint;
  totalStake: bigint;
  potentialReturn: bigint;
}

export interface EvaluateOptions {
  now: Date;
  limits: BettingLimits;
  /** Quotes (validate) may omit stakes; placement may not. */
  requireStake: boolean;
}

const issue = (code: ErrorCode, message?: string, extra: Partial<SlipIssue> = {}): SlipIssue => ({
  code,
  message: message ?? ERROR_MESSAGES[code],
  ...extra,
});

/** Why a selection cannot be bet right now, if it cannot. */
export function bettability(book: BookSelection, now: Date): SlipIssue | null {
  const at = { selectionId: book.selectionId };
  if (!book.eventIsActive)
    return issue('EVENT_CLOSED', 'Dieses Event ist nicht mehr im Angebot.', at);
  if (
    book.eventStatus === 'FINISHED' ||
    book.eventStatus === 'CANCELLED' ||
    book.eventStatus === 'POSTPONED'
  ) {
    return issue('EVENT_CLOSED', undefined, at);
  }
  // A pre-match price must never be taken after kick-off, even if the feed
  // has not flipped the event to live yet ("past-posting").
  if (book.eventStatus === 'SCHEDULED' && book.startTime.getTime() <= now.getTime()) {
    return issue('EVENT_CLOSED', 'Das Event hat bereits begonnen.', at);
  }
  if (book.eventStatus === 'SUSPENDED' || book.eventTradingSuspended) {
    return issue('MARKET_SUSPENDED', 'Wetten auf dieses Event sind vorübergehend gesperrt.', at);
  }
  if (book.marketStatus === 'CLOSED' || book.marketStatus === 'SETTLED') {
    return issue('EVENT_CLOSED', 'Dieser Markt ist geschlossen.', at);
  }
  if (book.marketStatus === 'SUSPENDED' || book.marketTradingSuspended) {
    return issue('MARKET_SUSPENDED', undefined, at);
  }
  if (book.selectionStatus === 'CLOSED')
    return issue('EVENT_CLOSED', 'Diese Auswahl ist nicht mehr verfügbar.', at);
  if (book.selectionStatus === 'SUSPENDED')
    return issue('MARKET_SUSPENDED', 'Diese Auswahl ist derzeit gesperrt.', at);
  return null;
}

/**
 * Decides whether the price the player saw may be honoured. With REJECT any
 * difference fails; with ACCEPT_HIGHER a price that moved up (in the player's
 * favour) is taken, but only within a bounded step — never a shortened price.
 */
export function acceptOdds(
  requestedMilli: number,
  currentMilli: number,
  policy: OddsChangePolicy,
  acceptHigherMaxPct: number,
): boolean {
  if (currentMilli === requestedMilli) return true;
  if (policy !== 'ACCEPT_HIGHER' || currentMilli < requestedMilli) return false;
  return currentMilli * 100 <= requestedMilli * (100 + acceptHigherMaxPct);
}

function formatMoney(minor: bigint): string {
  const sign = minor < 0n ? '-' : '';
  const abs = minor < 0n ? -minor : minor;
  return `${sign}${abs / 100n},${String(abs % 100n).padStart(2, '0')}`;
}

/**
 * Pure evaluation of a slip against the book. It never throws for a business
 * reason; it returns every problem it finds so the UI can show them together.
 */
export function evaluateSlip(
  request: SlipRequest,
  book: Map<string, BookSelection>,
  { now, limits, requireStake }: EvaluateOptions,
): SlipEvaluation {
  const issues: SlipIssue[] = [];
  const legs: PlannedLeg[] = [];

  if (request.legs.length === 0) issues.push(issue('VALIDATION_ERROR', 'Der Wettschein ist leer.'));
  if (request.legs.length > limits.maxSelections) {
    issues.push(
      issue('BET_LIMIT_EXCEEDED', `Höchstens ${limits.maxSelections} Auswahlen pro Wettschein.`),
    );
  }

  for (const leg of request.legs) {
    const current = book.get(leg.selectionId);
    if (!current) {
      issues.push(
        issue('NOT_FOUND', 'Diese Auswahl existiert nicht mehr.', { selectionId: leg.selectionId }),
      );
      continue;
    }
    const blocked = bettability(current, now);
    if (blocked) {
      issues.push(blocked);
      continue;
    }
    if (
      !acceptOdds(
        leg.requestedOddsMilli,
        current.oddsMilli,
        request.policy,
        limits.acceptHigherMaxPct,
      )
    ) {
      issues.push(
        issue('ODDS_CHANGED', undefined, {
          selectionId: leg.selectionId,
          currentOdds: fromMilli(current.oddsMilli),
          requestedOdds: fromMilli(leg.requestedOddsMilli),
        }),
      );
    }
    legs.push({ book: current, oddsMilli: current.oddsMilli });
  }

  const bets: PlannedBet[] = [];
  if (request.mode === 'COMBO') {
    const seen = new Set<string>();
    for (const leg of legs) {
      if (seen.has(leg.book.eventId)) {
        issues.push(
          issue(
            'VALIDATION_ERROR',
            'Auswahlen aus demselben Event können nicht kombiniert werden.',
            {
              selectionId: leg.book.selectionId,
            },
          ),
        );
      }
      seen.add(leg.book.eventId);
    }
    if (legs.length > 0) {
      const totalOddsMilli = combineOdds(legs.map((l) => l.oddsMilli));
      const stake = request.stake ?? 0n;
      bets.push({
        type: betTypeFor(legs.length),
        legs,
        stake,
        totalOddsMilli,
        potentialReturn: potentialReturn(stake, totalOddsMilli),
      });
    }
  } else {
    for (const leg of legs) {
      const stake = request.legs.find((l) => l.selectionId === leg.book.selectionId)?.stake ?? 0n;
      const totalOddsMilli = BigInt(leg.oddsMilli);
      bets.push({
        type: 'SINGLE',
        legs: [leg],
        stake,
        totalOddsMilli,
        potentialReturn: potentialReturn(stake, totalOddsMilli),
      });
    }
  }

  for (const bet of bets) {
    const at = bet.legs.length === 1 ? { selectionId: bet.legs[0]?.book.selectionId } : {};
    if (bet.totalOddsMilli > BigInt(limits.maxTotalOdds) * 1000n) {
      issues.push(
        issue(
          'BET_LIMIT_EXCEEDED',
          `Die Gesamtquote darf ${limits.maxTotalOdds} nicht übersteigen.`,
          at,
        ),
      );
    }
    if (bet.stake === 0n && !requireStake) continue;
    if (bet.stake < BigInt(limits.minStake)) {
      issues.push(
        issue(
          'BET_LIMIT_EXCEEDED',
          `Der Mindesteinsatz beträgt ${formatMoney(BigInt(limits.minStake))}.`,
          at,
        ),
      );
    } else if (bet.stake > BigInt(limits.maxStake)) {
      issues.push(
        issue(
          'BET_LIMIT_EXCEEDED',
          `Der Höchsteinsatz beträgt ${formatMoney(BigInt(limits.maxStake))}.`,
          at,
        ),
      );
    } else if (bet.potentialReturn > BigInt(limits.maxPayout)) {
      const allowed = maxStakeForPayout(BigInt(limits.maxPayout), bet.totalOddsMilli);
      issues.push(
        issue(
          'BET_LIMIT_EXCEEDED',
          `Der maximale Gewinn beträgt ${formatMoney(BigInt(limits.maxPayout))}. Höchstmöglicher Einsatz: ${formatMoney(allowed)}.`,
          at,
        ),
      );
    }
  }

  const combo = request.mode === 'COMBO' ? bets[0] : undefined;
  return {
    issues,
    bets,
    betType: combo ? combo.type : bets.length ? 'SINGLE' : null,
    totalOddsMilli: combo
      ? combo.totalOddsMilli
      : bets.length === 1
        ? (bets[0]?.totalOddsMilli ?? 0n)
        : 0n,
    totalStake: bets.reduce((sum, b) => sum + b.stake, 0n),
    potentialReturn: bets.reduce((sum, b) => sum + b.potentialReturn, 0n),
  };
}

export { formatMoney };
