import type { BetType } from '@storm-bet/types';

/**
 * Exact odds arithmetic. Odds are integers in thousandths (1.650 → 1650),
 * money is bigint minor units. Nothing here uses floating point, so a
 * payout is identical wherever it is computed.
 */

export const ODDS_SCALE = 1000n;

/** Decimal odds from the wire → thousandths. Rejects more than three decimals. */
export function toMilli(odds: number): number {
  const milli = Math.round(odds * 1000);
  if (Math.abs(milli - odds * 1000) > 1e-6 || milli <= 1000) {
    throw new RangeError(`invalid odds ${odds}`);
  }
  return milli;
}

export function fromMilli(milli: number | bigint): number {
  return Number(milli) / 1000;
}

/**
 * Combined odds of a multiple, truncated to three decimals — the figure shown
 * on the slip and the one the return is computed from.
 */
export function combineOdds(legs: readonly number[]): bigint {
  if (legs.length === 0) throw new RangeError('no legs');
  let product = 1n;
  for (const leg of legs) product *= BigInt(leg);
  return product / ODDS_SCALE ** BigInt(legs.length - 1);
}

/** Return (stake included) for a stake at combined odds; truncated to whole minor units. */
export function potentialReturn(stake: bigint, totalOddsMilli: bigint): bigint {
  return (stake * totalOddsMilli) / ODDS_SCALE;
}

/** Largest stake whose return stays within `maxPayout`. */
export function maxStakeForPayout(maxPayout: bigint, totalOddsMilli: bigint): bigint {
  return (maxPayout * ODDS_SCALE) / totalOddsMilli;
}

export function betTypeFor(legs: number): BetType {
  if (legs <= 1) return 'SINGLE';
  if (legs === 2) return 'DOUBLE';
  if (legs === 3) return 'TRIPLE';
  return 'ACCUMULATOR';
}
