import type { PlinkoResult, PlinkoRisk } from '@storm-bet/types';
import type { Rng } from '../rng';

export const PLINKO_ROWS = 12;

/** Bucket multipliers (left to right, symmetric) per risk level; our own tables. */
export const PLINKO_MULTIPLIERS: Record<PlinkoRisk, number[]> = {
  low: mirror([8.4, 2.9, 1.6, 1.3, 1.1, 1.0, 0.5]),
  medium: mirror([28, 9, 3.7, 1.8, 1.1, 0.6, 0.4]),
  high: mirror([160, 25, 8, 2, 0.6, 0.2, 0.2]),
};

function mirror(half: number[]): number[] {
  return [...half, ...half.slice(0, -1).reverse()];
}

function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return r;
}

/** Exact return to player of a risk level (each row: left or right, 50/50). */
export function plinkoRtp(risk: PlinkoRisk): number {
  const total = 2 ** PLINKO_ROWS;
  return PLINKO_MULTIPLIERS[risk].reduce(
    (sum, m, k) => sum + (choose(PLINKO_ROWS, k) / total) * m,
    0,
  );
}

export function dropPlinko(
  rng: Rng,
  stake: bigint,
  risk: PlinkoRisk,
): { result: PlinkoResult; payout: bigint } {
  const path: ('L' | 'R')[] = [];
  for (let i = 0; i < PLINKO_ROWS; i += 1) path.push(rng(2) === 0 ? 'L' : 'R');
  const bucket = path.filter((p) => p === 'R').length;
  const multiplier = PLINKO_MULTIPLIERS[risk][bucket]!;
  return {
    result: { game: 'PLINKO', risk, path, bucket, multiplier },
    payout: (stake * BigInt(Math.round(multiplier * 100))) / 100n,
  };
}
