import type { KenoResult } from '@storm-bet/types';
import type { Rng } from '../rng';

export const KENO_NUMBERS = 40;
export const KENO_DRAWN = 10;
export const KENO_MAX_PICKS = 10;

/** Return per unit by picks and hits (hits not listed pay nothing). RTP 94–97 %. */
export const KENO_PAYTABLE: Record<number, Record<number, number>> = {
  1: { 1: 3.8 },
  2: { 1: 1.3, 2: 8 },
  3: { 1: 0.7, 2: 2.5, 3: 25 },
  4: { 2: 2.1, 3: 8.5, 4: 80 },
  5: { 2: 1.1, 3: 4, 4: 23, 5: 300 },
  6: { 2: 0.6, 3: 2.4, 4: 10.5, 5: 85, 6: 1000 },
  7: { 3: 1.8, 4: 6.2, 5: 37, 6: 360, 7: 3000 },
  8: { 3: 1.3, 4: 3.8, 5: 16, 6: 110, 7: 900, 8: 5000 },
  9: { 3: 0.8, 4: 2.4, 5: 10.5, 6: 52, 7: 300, 8: 2500, 9: 10000 },
  10: { 3: 0.6, 4: 1.6, 5: 6, 6: 28, 7: 140, 8: 950, 9: 4800, 10: 10000 },
};

function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return r;
}

/** Expected return per unit for a number of picks (hypergeometric). */
export function kenoRtp(picks: number): number {
  const table = KENO_PAYTABLE[picks] ?? {};
  let rtp = 0;
  for (const [hits, pay] of Object.entries(table)) {
    const h = Number(hits);
    rtp +=
      ((choose(KENO_DRAWN, h) * choose(KENO_NUMBERS - KENO_DRAWN, picks - h)) /
        choose(KENO_NUMBERS, picks)) *
      pay;
  }
  return rtp;
}

/** Draws 10 of 1–40 on the server and pays the player's picks by the table. */
export function playKeno(
  rng: Rng,
  stake: bigint,
  picks: number[],
): { result: KenoResult; payout: bigint } {
  const unique = new Set(picks);
  if (
    picks.length < 1 ||
    picks.length > KENO_MAX_PICKS ||
    unique.size !== picks.length ||
    picks.some((p) => !Number.isInteger(p) || p < 1 || p > KENO_NUMBERS)
  )
    throw new RangeError('invalid picks');
  const pool = Array.from({ length: KENO_NUMBERS }, (_, i) => i + 1);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = rng(i + 1);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const drawn = pool.slice(0, KENO_DRAWN);
  const hits = picks.filter((p) => drawn.includes(p));
  const multiplier = KENO_PAYTABLE[picks.length]?.[hits.length] ?? 0;
  const hundredths = BigInt(Math.round(multiplier * 100));
  return {
    result: {
      game: 'KENO',
      picks: [...picks].sort((a, b) => a - b),
      drawn,
      hits: hits.sort((a, b) => a - b),
      multiplier,
    },
    payout: (stake * hundredths) / 100n,
  };
}
