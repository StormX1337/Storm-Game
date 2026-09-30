import type { WorkerEnv } from '@storm-bet/config';
import {
  MockOddsProvider,
  ResilientOddsProvider,
  SportsGameOddsProvider,
  TheOddsApiProvider,
  type OddsProvider,
} from '@storm-bet/odds-engine';
import type { Redis } from '@storm-bet/redis';

/**
 * The single place that decides which feed the platform runs on. Every
 * provider sits behind the same resilience layer (timeouts, retries, circuit
 * breaker, rate limit, cache, health metrics).
 */
export function createInnerProvider(env: WorkerEnv): OddsProvider {
  if (env.ODDS_PROVIDER === 'theoddsapi') {
    return new TheOddsApiProvider({
      apiKey: env.ODDS_API_KEY ?? '',
      baseUrl: env.ODDS_API_BASE_URL,
      sports: env.ODDS_API_SPORTS,
      regions: env.ODDS_API_REGIONS,
      bookmakers: env.ODDS_API_BOOKMAKERS,
      oddsTtlMs: env.ODDS_API_ODDS_TTL_SECONDS * 1000,
      scoresTtlMs: env.ODDS_API_SCORES_TTL_SECONDS * 1000,
      minRemainingCredits: env.ODDS_API_MIN_REMAINING,
      liveBetting: env.ODDS_API_LIVE_BETTING,
      liveMaxAgeMs: env.ODDS_API_LIVE_MAX_AGE_SECONDS * 1000,
    });
  }
  if (env.ODDS_PROVIDER === 'sportsgameodds') {
    return new SportsGameOddsProvider({
      apiKey: env.SGO_API_KEY ?? '',
      baseUrl: env.SGO_BASE_URL,
      leagues: env.SGO_LEAGUES,
      bookmakers: env.SGO_BOOKMAKERS,
      horizonHours: env.SGO_HORIZON_HOURS,
      oddsTtlMs: env.SGO_ODDS_TTL_SECONDS * 1000,
      liveTtlMs: env.SGO_LIVE_TTL_SECONDS * 1000,
      minRemainingObjects: env.SGO_MIN_REMAINING,
      liveBetting: env.SGO_LIVE_BETTING,
      liveMaxAgeMs: env.SGO_LIVE_MAX_AGE_SECONDS * 1000,
      settleAfterMs: env.SGO_SETTLE_AFTER_MINUTES * 60_000,
    });
  }
  return new MockOddsProvider({ seed: env.MOCK_SEED, timeScale: env.MOCK_TIME_SCALE });
}

export function createProvider(env: WorkerEnv, redis: Redis): ResilientOddsProvider {
  const real = env.ODDS_PROVIDER !== 'mock';
  return new ResilientOddsProvider(createInnerProvider(env), redis, {
    // A real HTTP feed needs more headroom than the in-process simulator: a
    // first snapshot of many leagues can be several paged downloads.
    timeoutMs: real ? Math.max(env.PROVIDER_TIMEOUT_MS, 60_000) : env.PROVIDER_TIMEOUT_MS,
    maxRetries: env.PROVIDER_MAX_RETRIES,
    rateLimitPerMinute: env.PROVIDER_RATE_LIMIT_PER_MINUTE,
    // The real-feed providers keep their own quota-aware snapshots.
    cacheTtlSeconds: env.PROVIDER_CACHE_TTL_SECONDS,
  });
}
