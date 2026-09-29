import { SLOT_PAYLINES, type SlotResult, type SlotSymbol } from '@storm-bet/types';
import type { Rng } from '../rng';

/**
 * 5 reels × 3 rows, 10 fixed paylines, pays left to right for 3, 4 or 5 of a
 * kind. Every cell is drawn independently with these weights, so the return
 * to player is exact: Σ p³(1−p)·m₃ + p⁴(1−p)·m₄ + p⁵·m₅ = 95.36 % (see tests).
 */
export const SLOT_WEIGHTS: Record<SlotSymbol, number> = {
  bolt: 3,
  crown: 5,
  gem: 8,
  star: 12,
  clover: 17,
  cherry: 25,
  lemon: 30,
};

/** Multipliers of the line bet for 3, 4 and 5 of a kind. */
export const SLOT_PAYS: Record<SlotSymbol, [number, number, number]> = {
  bolt: [250, 1000, 5000],
  crown: [120, 500, 2000],
  gem: [60, 200, 750],
  star: [40, 100, 400],
  clover: [20, 50, 200],
  cherry: [10, 30, 100],
  lemon: [5, 20, 60],
};

/** Row index per reel for each payline (shared with the client for highlighting). */
export const PAYLINES = SLOT_PAYLINES;

export const SLOT_RTP = 95.36;

const SYMBOLS = Object.keys(SLOT_WEIGHTS) as SlotSymbol[];
const TOTAL_WEIGHT = SYMBOLS.reduce((s, k) => s + SLOT_WEIGHTS[k], 0);

function drawSymbol(rng: Rng): SlotSymbol {
  let n = rng(TOTAL_WEIGHT);
  for (const s of SYMBOLS) {
    n -= SLOT_WEIGHTS[s];
    if (n < 0) return s;
  }
  return SYMBOLS[SYMBOLS.length - 1]!;
}

/** Evaluates a fixed grid (used by tests and by spinSlot). */
export function evaluateSlot(
  reels: SlotSymbol[][],
  stake: bigint,
): { result: SlotResult; payout: bigint } {
  const wins: SlotResult['wins'] = [];
  let multiplierSum = 0;
  PAYLINES.forEach((rows, line) => {
    const symbols = rows.map((row, reel) => reels[reel]![row]!);
    const first = symbols[0]!;
    let count = 1;
    while (count < symbols.length && symbols[count] === first) count++;
    if (count >= 3) {
      const multiplier = SLOT_PAYS[first][count - 3]!;
      multiplierSum += multiplier;
      wins.push({ line: line + 1, symbol: first, count, multiplier });
    }
  });
  // Line bet = stake / 10; the book rounds down to whole minor units.
  const payout = (stake * BigInt(multiplierSum)) / BigInt(PAYLINES.length);
  return { result: { game: 'SLOT', reels, wins }, payout };
}

export function spinSlot(rng: Rng, stake: bigint): { result: SlotResult; payout: bigint } {
  const reels = Array.from({ length: 5 }, () => Array.from({ length: 3 }, () => drawSymbol(rng)));
  return evaluateSlot(reels, stake);
}
