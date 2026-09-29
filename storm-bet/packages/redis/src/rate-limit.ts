import { randomUUID } from 'node:crypto';
import { REDIS_KEYS } from '@storm-bet/config/constants';
import type { Redis } from 'ioredis';

// Sliding-window log in a sorted set. Atomic in one script so concurrent
// requests cannot both squeeze through the last slot.
const SLIDING_WINDOW = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('zremrangebyscore', key, 0, now - window)
local count = redis.call('zcard', key)
if count < limit then
  redis.call('zadd', key, now, member)
  redis.call('pexpire', key, window)
  return {1, limit - count - 1, 0}
end
local oldest = redis.call('zrange', key, 0, 0, 'WITHSCORES')
local retry = window
if oldest[2] then retry = tonumber(oldest[2]) + window - now end
return {0, 0, retry}
`;

export interface RateLimitRule {
  /** Namespace, e.g. "login-ip". */
  bucket: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export async function consumeRateLimit(
  redis: Redis,
  rule: RateLimitRule,
  identifier: string,
  now = Date.now(),
): Promise<RateLimitResult> {
  const key = REDIS_KEYS.rateLimit(rule.bucket, identifier);
  const [allowed, remaining, retry] = (await redis.eval(
    SLIDING_WINDOW,
    1,
    key,
    String(now),
    String(rule.windowMs),
    String(rule.limit),
    `${now}:${randomUUID()}`,
  )) as [number, number, number];
  return { allowed: allowed === 1, remaining, retryAfterMs: Math.max(0, retry) };
}

export async function resetRateLimit(
  redis: Redis,
  rule: RateLimitRule,
  identifier: string,
): Promise<void> {
  await redis.del(REDIS_KEYS.rateLimit(rule.bucket, identifier));
}
