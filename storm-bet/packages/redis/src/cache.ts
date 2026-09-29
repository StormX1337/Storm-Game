import { REDIS_KEYS } from '@storm-bet/config/constants';
import type { Redis } from 'ioredis';

/**
 * Read-through JSON cache. Only ever used for public catalogue reads; nothing
 * that decides money (bet placement, settlement) reads from here.
 */
export class JsonCache {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly redis: Redis) {}

  async get<T>(name: string): Promise<T | null> {
    const raw = await this.redis.get(REDIS_KEYS.cache(name));
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set(name: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(REDIS_KEYS.cache(name), JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(...names: string[]): Promise<void> {
    if (names.length) await this.redis.del(...names.map((n) => REDIS_KEYS.cache(n)));
  }

  /** Deletes every key under a prefix, e.g. "events:" after an admin edit. */
  async delPrefix(prefix: string): Promise<void> {
    const pattern = `${REDIS_KEYS.cache(prefix)}*`;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length) await this.redis.del(...keys);
    } while (cursor !== '0');
  }

  /**
   * Returns the cached value or computes it. Concurrent misses in this
   * process share one computation, so a cold key does not stampede the DB.
   * A Redis outage degrades to computing every time rather than failing.
   */
  async wrap<T>(name: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
    try {
      const hit = await this.get<T>(name);
      if (hit !== null) return hit;
    } catch {
      return compute();
    }
    const pending = this.inflight.get(name) as Promise<T> | undefined;
    if (pending) return pending;
    const job = compute()
      .then(async (value) => {
        await this.set(name, value, ttlSeconds).catch(() => undefined);
        return value;
      })
      .finally(() => this.inflight.delete(name));
    this.inflight.set(name, job);
    return job;
  }
}
