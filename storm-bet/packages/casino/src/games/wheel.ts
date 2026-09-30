import type { WheelResult } from '@storm-bet/types';
import type { Rng } from '../rng';

/** 50 segments: 29 × 0, 10 × 1.5, 6 × 2, 3 × 3, 1 × 5, 1 × 7 — RTP 96 %. */
const PRIZES = [7, 1.5, 2, 1.5, 3, 1.5, 2, 1.5, 5, 1.5, 2, 3, 1.5, 2, 1.5, 3, 2, 1.5, 2, 1.5, 1.5];
export const WHEEL_SEGMENTS: number[] = (() => {
  const nonZero = PRIZES;
  const out: number[] = [];
  let next = 0;
  for (let i = 0; i < 50; i += 1) {
    // Spread the prizes evenly between the empty segments.
    const due = Math.floor(((i + 1) * nonZero.length) / 50) > Math.floor((i * nonZero.length) / 50);
    out.push(due ? nonZero[next++]! : 0);
  }
  return out;
})();

export function wheelRtp(): number {
  return WHEEL_SEGMENTS.reduce((a, b) => a + b, 0) / WHEEL_SEGMENTS.length;
}

export function spinWheel(rng: Rng, stake: bigint): { result: WheelResult; payout: bigint } {
  const segment = rng(WHEEL_SEGMENTS.length);
  const multiplier = WHEEL_SEGMENTS[segment]!;
  return {
    result: { game: 'WHEEL', segment, multiplier },
    payout: (stake * BigInt(Math.round(multiplier * 100))) / 100n,
  };
}
