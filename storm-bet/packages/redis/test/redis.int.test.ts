import { afterAll, describe, expect, it } from 'vitest';
import { acquireLock, consumeRateLimit, createRedis, JsonCache, withLock } from '../src';

const redis = createRedis(process.env.REDIS_URL!);

afterAll(async () => {
  await redis.quit();
});

describe('distributed lock', () => {
  it('is exclusive and only released by its owner', async () => {
    const name = `test-${Math.random()}`;
    const first = await acquireLock(redis, name, { ttlMs: 5_000 });
    expect(first).not.toBeNull();
    expect(await acquireLock(redis, name, { ttlMs: 5_000 })).toBeNull();
    expect(await first!.release()).toBe(true);
    expect(await first!.release()).toBe(false);
    const second = await acquireLock(redis, name, { ttlMs: 5_000 });
    expect(second).not.toBeNull();
    await second!.release();
  });

  it('serialises concurrent critical sections', async () => {
    const name = `test-${Math.random()}`;
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withLock(redis, name, { ttlMs: 5_000, waitMs: 5_000, retryDelayMs: 5 }, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await new Promise((r) => setTimeout(r, 10));
          inside -= 1;
        }),
      ),
    );
    expect(maxInside).toBe(1);
  });
});

describe('rate limiter', () => {
  it('allows exactly the limit inside the window', async () => {
    const rule = { bucket: `test-${Math.random()}`, limit: 3, windowMs: 1_000 };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => consumeRateLimit(redis, rule, 'client')),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    const denied = results.find((r) => !r.allowed)!;
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });
});

describe('json cache', () => {
  it('computes once for concurrent misses', async () => {
    const cache = new JsonCache(redis);
    let calls = 0;
    const name = `test-${Math.random()}`;
    const values = await Promise.all(
      Array.from({ length: 5 }, () =>
        cache.wrap(name, 5, async () => {
          calls += 1;
          return { value: 42 };
        }),
      ),
    );
    expect(calls).toBe(1);
    expect(values.every((v) => v.value === 42)).toBe(true);
    expect(await cache.get(name)).toEqual({ value: 42 });
  });
});
