import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { REDIS_KEYS } from '@storm-bet/config/constants';
import type { Redis } from 'ioredis';

// Release and extend only if we still own the lock: comparing the token
// keeps a slow holder from deleting a lock that has since passed to someone else.
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const EXTEND = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

export interface Lock {
  key: string;
  token: string;
  release(): Promise<boolean>;
  extend(ttlMs: number): Promise<boolean>;
}

export class LockUnavailableError extends Error {
  constructor(readonly name_: string) {
    super(`Lock "${name_}" is held by another process`);
    this.name = 'LockUnavailableError';
  }
}

export interface AcquireOptions {
  ttlMs: number;
  /** How long to keep trying; 0 tries exactly once. */
  waitMs?: number;
  retryDelayMs?: number;
}

/**
 * Single-instance Redis lock (SET NX PX + token-checked release). It guards
 * against concurrent work, not against data corruption: every critical write
 * is still protected by row locks and constraints in PostgreSQL, so a lock
 * lost to a Redis failover degrades to "two workers try, one wins".
 */
export async function acquireLock(
  redis: Redis,
  name: string,
  { ttlMs, waitMs = 0, retryDelayMs = 50 }: AcquireOptions,
): Promise<Lock | null> {
  const key = REDIS_KEYS.lock(name);
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
    if (ok === 'OK') {
      return {
        key,
        token,
        release: async () => (await redis.eval(RELEASE, 1, key, token)) === 1,
        extend: async (ms) => (await redis.eval(EXTEND, 1, key, token, String(ms))) === 1,
      };
    }
    if (Date.now() >= deadline) return null;
    await sleep(retryDelayMs + Math.floor(Math.random() * retryDelayMs));
  }
}

export async function withLock<T>(
  redis: Redis,
  name: string,
  options: AcquireOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await acquireLock(redis, name, options);
  if (!lock) throw new LockUnavailableError(name);
  try {
    return await fn();
  } finally {
    await lock.release().catch(() => undefined);
  }
}
