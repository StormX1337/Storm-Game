import { ODDS_SCALE } from './odds';

/** System bets take 3 to 8 selections; C(8, 4) = 70 combinations at most. */
export const SYSTEM_MIN_LEGS = 3;
export const SYSTEM_MAX_LEGS = 8;

/** Every way to pick `size` of the indices 0 … n − 1, in lexicographic order. */
export function combinations(n: number, size: number): number[][] {
  const out: number[][] = [];
  const pick: number[] = [];
  const walk = (from: number) => {
    if (pick.length === size) {
      out.push([...pick]);
      return;
    }
    for (let i = from; i <= n - (size - pick.length); i += 1) {
      pick.push(i);
      walk(i + 1);
      pick.pop();
    }
  };
  if (size >= 1 && size <= n) walk(0);
  return out;
}

/** Number of combinations ("Wetten") in a system size of n. */
export function systemLines(n: number, size: number): number {
  if (size < 1 || size > n) return 0;
  let lines = 1;
  for (let i = 1; i <= size; i += 1) lines = (lines * (n - size + i)) / i;
  return Math.round(lines);
}

/** Odds of each combination (thousandths, truncated like any multiple). */
export function systemComboOdds(oddsMilli: readonly number[], size: number): bigint[] {
  return combinations(oddsMilli.length, size).map((combo) => {
    let product = 1n;
    for (const i of combo) product *= BigInt(oddsMilli[i]!);
    return product / ODDS_SCALE ** BigInt(size - 1);
  });
}

/** Return if every selection wins: each combination pays its stake × its odds. */
export function systemPotentialReturn(
  unitStake: bigint,
  oddsMilli: readonly number[],
  size: number,
): bigint {
  return systemComboOdds(oddsMilli, size).reduce(
    (sum, odds) => sum + (unitStake * odds) / ODDS_SCALE,
    0n,
  );
}
