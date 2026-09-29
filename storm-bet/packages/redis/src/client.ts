import { Redis, type RedisOptions } from 'ioredis';

export type { Redis } from 'ioredis';

export function createRedis(url: string, options: RedisOptions = {}): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    // Reconnect with a capped backoff instead of giving up.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    ...options,
  });
}

/** Separate connection for SUBSCRIBE — a subscribed client can do nothing else. */
export function createSubscriber(url: string): Redis {
  return createRedis(url, { maxRetriesPerRequest: null });
}
