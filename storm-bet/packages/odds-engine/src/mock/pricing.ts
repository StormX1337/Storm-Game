/**
 * Probability → price. The margin is applied proportionally and openly (the
 * overround is a documented constant per market group), then prices are
 * rounded to the nearest step of a conventional ladder. Nothing here skews a
 * price against one side.
 */

export const MARGINS = {
  main: 0.05,
  totals: 0.06,
  props: 0.08,
  players: 0.12,
} as const;

export const MIN_ODDS = 1.01;
export const MAX_ODDS = 500;
/** Outcomes this unlikely (or likely) are not offered; the market is suspended. */
export const MIN_OFFERED_PROBABILITY = 0.015;

const LADDER: [limit: number, step: number][] = [
  [2, 0.01],
  [3, 0.02],
  [4, 0.05],
  [6, 0.1],
  [10, 0.2],
  [20, 0.5],
  [50, 1],
  [100, 5],
  [Infinity, 10],
];

export function roundToLadder(odds: number): number {
  const clamped = Math.min(MAX_ODDS, Math.max(MIN_ODDS, odds));
  const step = LADDER.find(([limit]) => clamped < limit)?.[1] ?? 10;
  const rounded = Math.round(clamped / step) * step;
  // Integer thousandths: the value stored and compared everywhere else.
  return Math.max(MIN_ODDS, Math.round(rounded * 1000) / 1000);
}

/**
 * Prices a set of mutually exclusive outcomes. Probabilities are normalised
 * first, so small model inaccuracies cannot produce a book below 100 %.
 */
export function priceOutcomes(probabilities: number[], margin: number): number[] {
  const total = probabilities.reduce((a, b) => a + b, 0);
  return probabilities.map((p) => {
    const fair = total > 0 ? p / total : 0;
    return fair <= 0 ? MAX_ODDS : roundToLadder(1 / (fair * (1 + margin)));
  });
}

/** Prices an outcome that is not part of a partition (e.g. "player X scores"). */
export function priceSingle(probability: number, margin: number): number {
  return probability <= 0
    ? MAX_ODDS
    : roundToLadder(1 / Math.min(0.99, probability * (1 + margin)));
}

export function poissonPmf(lambda: number, maxK: number): number[] {
  const out: number[] = [];
  let p = Math.exp(-lambda);
  for (let k = 0; k <= maxK; k += 1) {
    out.push(p);
    p = (p * lambda) / (k + 1);
  }
  // Fold the tail into the last bucket so the distribution sums to 1.
  const sum = out.reduce((a, b) => a + b, 0);
  out[maxK] = (out[maxK] ?? 0) + Math.max(0, 1 - sum);
  return out;
}

/** P(X > line) for X = current + Poisson(lambda). */
export function poissonOver(current: number, lambda: number, line: number): number {
  const needed = Math.floor(line - current) + 1; // additional events required
  if (needed <= 0) return 1;
  const pmf = poissonPmf(lambda, Math.max(needed + 20, 30));
  let under = 0;
  for (let k = 0; k < needed; k += 1) under += pmf[k] ?? 0;
  return Math.min(1, Math.max(0, 1 - under));
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

export function clampProbability(p: number): number {
  return Math.min(1, Math.max(0, p));
}

export function isOffered(p: number): boolean {
  return p >= MIN_OFFERED_PROBABILITY && p <= 1 - MIN_OFFERED_PROBABILITY;
}
