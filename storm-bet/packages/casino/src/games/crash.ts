import type { CrashResult } from '@storm-bet/types';
import type { Rng } from '../rng';

/** Return to player: P(crash point ≥ m) = RTP / m, for every target m. */
export const CRASH_RTP = 0.97;
export const CRASH_MIN_TARGET = 101; // hundredths: 1.01×
export const CRASH_MAX_TARGET = 10_000; // 100.00×
const RESOLUTION = 1_000_000;

/** The multiplier the round crashes at, in hundredths (100 = 1.00×). */
export function crashPoint(rng: Rng): number {
  const u = (rng(RESOLUTION) + 1) / RESOLUTION; // (0, 1]
  const point = Math.floor((CRASH_RTP / u) * 100);
  return Math.max(100, Math.min(point, 100 * RESOLUTION));
}

/**
 * One crash round: the player's cash-out target is fixed before the round,
 * the crash point is drawn on the server. Target reached → stake × target.
 */
export function playCrash(
  rng: Rng,
  stake: bigint,
  target: number,
): { result: CrashResult; payout: bigint } {
  if (!Number.isInteger(target) || target < CRASH_MIN_TARGET || target > CRASH_MAX_TARGET)
    throw new RangeError('crash target out of range');
  const point = crashPoint(rng);
  const won = point >= target;
  return {
    result: { game: 'CRASH', target: target / 100, crashPoint: point / 100, won },
    payout: won ? (stake * BigInt(target)) / 100n : 0n,
  };
}
