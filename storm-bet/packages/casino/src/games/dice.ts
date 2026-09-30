import type { DiceResult } from '@storm-bet/types';
import type { Rng } from '../rng';

export const DICE_RTP = 0.97;
export const DICE_MIN_CHANCE = 1;
export const DICE_MAX_CHANCE = 95;

/** Payout multiplier (hundredths) for a win chance in percent: 97 % ÷ chance. */
export function diceMultiplier(chance: number): number {
  return Math.floor((DICE_RTP * 100 * 100) / chance);
}

/**
 * A roll of 0.00–99.99. "under" wins below the chance, "over" wins at or
 * above 100 − chance; either way the win chance is exactly `chance` %.
 */
export function rollDice(
  rng: Rng,
  stake: bigint,
  chance: number,
  direction: 'under' | 'over',
): { result: DiceResult; payout: bigint } {
  if (!Number.isInteger(chance) || chance < DICE_MIN_CHANCE || chance > DICE_MAX_CHANCE)
    throw new RangeError('chance out of range');
  const roll = rng(10_000);
  const threshold = direction === 'under' ? chance * 100 : 10_000 - chance * 100;
  const won = direction === 'under' ? roll < threshold : roll >= threshold;
  const multiplier = diceMultiplier(chance);
  return {
    result: {
      game: 'DICE',
      roll: roll / 100,
      chance,
      direction,
      threshold: threshold / 100,
      multiplier: multiplier / 100,
      won,
    },
    payout: won ? (stake * BigInt(multiplier)) / 100n : 0n,
  };
}
