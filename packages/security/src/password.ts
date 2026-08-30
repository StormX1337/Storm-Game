import { hash, verify } from '@node-rs/argon2';

/** `Algorithm.Argon2id` from @node-rs/argon2, inlined: it ships as a const enum. */
const ARGON2ID = 2;

/**
 * Argon2id parameters. Tuned for ~50-80ms on a modern vCPU, which keeps login
 * responsive while making offline cracking expensive. Bumping these is safe:
 * `needsRehash` detects stale hashes on the next successful login.
 */
export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456, // 19 MiB — OWASP minimum recommendation
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('Cannot hash an empty password');
  }
  if (plain.length > 1024) {
    throw new Error('Password exceeds maximum supported length');
  }
  return hash(plain, ARGON2_OPTIONS);
}

/**
 * Verifies a password. Never throws on malformed hashes — a corrupt row must
 * read as "wrong password", not as a 500 that leaks which accounts are broken.
 */
export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  if (!digest || !plain) return false;
  try {
    return await verify(digest, plain, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/** True when the stored hash was produced with weaker parameters than current. */
export function needsRehash(digest: string): boolean {
  const match = /^\$argon2(id|i|d)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(digest);
  if (!match) return true;
  const [, variant, , memory, time, parallelism] = match;
  if (variant !== 'id') return true;
  return (
    Number(memory) < ARGON2_OPTIONS.memoryCost ||
    Number(time) < ARGON2_OPTIONS.timeCost ||
    Number(parallelism) < ARGON2_OPTIONS.parallelism
  );
}
