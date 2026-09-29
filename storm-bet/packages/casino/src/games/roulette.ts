import type { RouletteBet, RouletteResult } from '@storm-bet/types';
import type { Rng } from '../rng';

/** European single-zero roulette: return to player 97.30 % on every bet. */
export const ROULETTE_RTP = 97.3;

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export function colorOf(n: number): RouletteResult['color'] {
  return n === 0 ? 'green' : RED.has(n) ? 'red' : 'black';
}

/** Total returned per unit staked when the bet wins (stake included). */
const RETURN: Record<RouletteBet['type'], number> = {
  straight: 36,
  dozen: 3,
  column: 3,
  red: 2,
  black: 2,
  odd: 2,
  even: 2,
  low: 2,
  high: 2,
};

export function rouletteBetValid(bet: RouletteBet): boolean {
  if (bet.type === 'straight')
    return Number.isInteger(bet.value) && bet.value! >= 0 && bet.value! <= 36;
  if (bet.type === 'dozen' || bet.type === 'column')
    return Number.isInteger(bet.value) && bet.value! >= 1 && bet.value! <= 3;
  return bet.value === undefined;
}

export function rouletteBetWins(bet: RouletteBet, n: number): boolean {
  if (bet.type === 'straight') return n === bet.value;
  if (n === 0) return false;
  switch (bet.type) {
    case 'red':
      return RED.has(n);
    case 'black':
      return !RED.has(n);
    case 'odd':
      return n % 2 === 1;
    case 'even':
      return n % 2 === 0;
    case 'low':
      return n <= 18;
    case 'high':
      return n >= 19;
    case 'dozen':
      return Math.ceil(n / 12) === bet.value;
    case 'column':
      return ((n - 1) % 3) + 1 === bet.value;
  }
}

export function resolveRoulette(
  n: number,
  bets: RouletteBet[],
): { result: RouletteResult; payout: bigint } {
  let payout = 0n;
  const resolved = bets.map((bet) => {
    const won = rouletteBetWins(bet, n) ? BigInt(bet.stake) * BigInt(RETURN[bet.type]) : 0n;
    payout += won;
    return { ...bet, payout: Number(won) };
  });
  return { result: { game: 'ROULETTE', number: n, color: colorOf(n), bets: resolved }, payout };
}

export function spinRoulette(rng: Rng, bets: RouletteBet[]) {
  return resolveRoulette(rng(37), bets);
}
