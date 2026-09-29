import { hash, verify } from '@node-rs/argon2';

/** `Algorithm.Argon2id` — @node-rs/argon2 ships it as a const enum. */
const ARGON2ID = 2;

/**
 * Argon2id at the OWASP baseline (19 MiB, t=2, p=1). Raising these is safe:
 * `needsRehash` flags older hashes and login upgrades them transparently.
 */
export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

const MAX_PASSWORD_BYTES = 1024;

export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('Cannot hash an empty password');
  }
  if (Buffer.byteLength(plain, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new Error('Password exceeds the supported length');
  }
  return hash(plain, ARGON2_OPTIONS);
}

/** Never throws: a malformed stored hash reads as a wrong password, not a 500. */
export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  if (!digest || !plain || Buffer.byteLength(plain, 'utf8') > MAX_PASSWORD_BYTES) return false;
  try {
    return await verify(digest, plain);
  } catch {
    return false;
  }
}

export function needsRehash(digest: string): boolean {
  const match = /^\$argon2(id|i|d)\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(digest);
  if (!match) return true;
  const [, variant, memory, time, parallelism] = match;
  return (
    variant !== 'id' ||
    Number(memory) < ARGON2_OPTIONS.memoryCost ||
    Number(time) < ARGON2_OPTIONS.timeCost ||
    Number(parallelism) < ARGON2_OPTIONS.parallelism
  );
}

let dummyHash: Promise<string> | null = null;

/**
 * Burns the same work as a real verification. Login calls this when the
 * account does not exist, so response time does not reveal which emails are
 * registered.
 */
export async function verifyAgainstDummy(plain: string): Promise<false> {
  dummyHash ??= hashPassword('storm-bet-timing-equaliser');
  await verifyPassword(await dummyHash, plain || 'x');
  return false;
}
