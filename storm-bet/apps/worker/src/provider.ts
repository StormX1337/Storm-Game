import type { WorkerEnv } from '@storm-bet/config';
import { MockOddsProvider, ResilientOddsProvider } from '@storm-bet/odds-engine';
import type { Redis } from '@storm-bet/redis';

/**
 * The single place that decides which feed the platform runs on. A licensed
 * provider is added here by implementing OddsProvider; everything else stays.
 */
export function createProvider(env: WorkerEnv, redis: Redis): ResilientOddsProvider {
  const inner = new MockOddsProvider({ seed: env.MOCK_SEED, timeScale: env.MOCK_TIME_SCALE });
  return new ResilientOddsProvider(inner, redis, {
    timeoutMs: env.PROVIDER_TIMEOUT_MS,
    maxRetries: env.PROVIDER_MAX_RETRIES,
    rateLimitPerMinute: env.PROVIDER_RATE_LIMIT_PER_MINUTE,
    cacheTtlSeconds: env.PROVIDER_CACHE_TTL_SECONDS,
  });
}
