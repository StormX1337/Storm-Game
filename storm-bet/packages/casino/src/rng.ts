import { randomInt } from 'node:crypto';

/** Uniform integer in [0, maxExclusive). Every game outcome comes from one of these. */
export type Rng = (maxExclusive: number) => number;

/** Cryptographically secure; outcomes are decided on the server only. */
export const cryptoRng: Rng = (maxExclusive) => randomInt(maxExclusive);
