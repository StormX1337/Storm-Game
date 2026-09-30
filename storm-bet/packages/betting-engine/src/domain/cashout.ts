import type { BetType, SelectionResult } from '@storm-bet/types';
import { bettability, type BookSelection } from './slip';

export interface CashoutLeg {
  /** Odds the leg was accepted at, in thousandths. */
  oddsMilli: number;
  result: SelectionResult;
  /** The book's current view of the leg's selection. */
  book: BookSelection | undefined;
}

export type CashoutQuote =
  | { available: true; amount: bigint }
  | { available: false; reason: string };

/**
 * What an open bet is worth now, at the book's current prices:
 *
 *   stake × Π(won: odds) × Π(open: odds at placement ÷ current odds) × (1 − margin)
 *
 * Void legs count 1.00, as at settlement. The current prices already carry the
 * book's margin; the published deduction comes on top. Truncated to whole
 * minor units and never above the bet's potential return. Only a bet whose
 * open legs can all be bet right now has a value: a suspended market means
 * no reliable price, so no cashout.
 */
export function cashoutValue(
  bet: { type: BetType; stake: bigint; potentialReturn: bigint },
  legs: readonly CashoutLeg[],
  now: Date,
  marginPct: number,
): CashoutQuote {
  if (bet.type === 'BET_BUILDER') {
    return { available: false, reason: 'Für Bet Builder gibt es keinen Cashout.' };
  }
  if (legs.some((l) => l.result === 'LOST')) {
    return { available: false, reason: 'Die Wette ist bereits verloren.' };
  }
  const open = legs.filter((l) => l.result === 'PENDING');
  if (open.length === 0) {
    return { available: false, reason: 'Die Wette wird gerade abgerechnet.' };
  }
  for (const leg of open) {
    if (!leg.book || bettability(leg.book, now) !== null) {
      return { available: false, reason: 'Cashout ist gerade nicht möglich (Markt gesperrt).' };
    }
  }
  let numerator = bet.stake * BigInt(100 - marginPct);
  let denominator = 100n;
  for (const leg of legs) {
    if (leg.result === 'WON') {
      numerator *= BigInt(leg.oddsMilli);
      denominator *= 1000n;
    } else if (leg.result === 'PENDING') {
      numerator *= BigInt(leg.oddsMilli);
      denominator *= BigInt(leg.book!.oddsMilli);
    }
  }
  let amount = numerator / denominator;
  if (amount > bet.potentialReturn) amount = bet.potentialReturn;
  if (amount <= 0n) return { available: false, reason: 'Kein Cashout-Wert verfügbar.' };
  return { available: true, amount };
}
