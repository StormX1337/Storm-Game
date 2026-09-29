import { REDIS_KEYS } from '@storm-bet/config/constants';
import { consumeRateLimit, JsonCache, type Redis } from '@storm-bet/redis';
import type { ProviderHealthDto, ProviderState, SportKey } from '@storm-bet/types';
import {
  CircuitOpenError,
  ProviderError,
  ProviderRateLimitedError,
  ProviderTimeoutError,
  type EventQuery,
  type OddsProvider,
  type ProviderEvent,
  type ProviderLeague,
  type ProviderMarket,
  type ProviderSport,
} from './provider';

export interface ResilienceOptions {
  timeoutMs: number;
  maxRetries: number;
  /** Base for exponential backoff with full jitter. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  rateLimitPerMinute: number;
  /** Consecutive failures that open the circuit. */
  failureThreshold?: number;
  /** How long an open circuit rejects calls before one probe is let through. */
  openMs?: number;
  /** TTL for volatile reads (events, markets). 0 disables caching. */
  cacheTtlSeconds: number;
  /** TTL for reference data (sports, leagues). */
  referenceTtlSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface HealthRecord {
  requests: number;
  failures: number;
  consecutiveFailures: number;
  avgLatencyMs: number | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Decorates any OddsProvider with the behaviour a production feed needs:
 * per-call timeouts, bounded retries with jittered backoff, a circuit breaker,
 * a shared (Redis) rate limit, response caching and health metrics.
 */
export class ResilientOddsProvider implements OddsProvider {
  readonly key: string;
  readonly name: string;
  readonly isSimulated: boolean;

  private readonly cache: JsonCache;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private circuit: CircuitState = 'CLOSED';
  private openedAt = 0;
  private probeInFlight = false;
  private health: HealthRecord = {
    requests: 0,
    failures: 0,
    consecutiveFailures: 0,
    avgLatencyMs: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
  };

  constructor(
    private readonly inner: OddsProvider,
    private readonly redis: Redis,
    private readonly options: ResilienceOptions,
  ) {
    this.key = inner.key;
    this.name = inner.name;
    this.isSimulated = inner.isSimulated;
    this.cache = new JsonCache(redis);
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  getSports(): Promise<ProviderSport[]> {
    return this.cached('sports', this.referenceTtl, () => this.inner.getSports());
  }

  getLeagues(sportKey?: SportKey): Promise<ProviderLeague[]> {
    return this.cached(`leagues:${sportKey ?? 'all'}`, this.referenceTtl, () =>
      this.inner.getLeagues(sportKey),
    );
  }

  getEvents(query: EventQuery): Promise<ProviderEvent[]> {
    return this.cached(
      `events:${query.sportKey ?? 'all'}:${query.from}:${query.to}`,
      this.options.cacheTtlSeconds,
      () => this.inner.getEvents(query),
    );
  }

  getEvent(externalId: string): Promise<ProviderEvent | null> {
    return this.cached(`event:${externalId}`, this.options.cacheTtlSeconds, () =>
      this.inner.getEvent(externalId),
    );
  }

  getMarkets(eventExternalId: string): Promise<ProviderMarket[]> {
    return this.cached(`markets:${eventExternalId}`, this.options.cacheTtlSeconds, () =>
      this.inner.getMarkets(eventExternalId),
    );
  }

  /** Request credits of a metered feed, if the wrapped provider reports them. */
  private quota(): ProviderHealthDto['quota'] {
    const inner = this.inner as OddsProvider & {
      getQuota?: () => { remaining: number | null; used: number | null; exhausted: boolean };
    };
    if (typeof inner.getQuota !== 'function') return null;
    const q = inner.getQuota();
    return { remaining: q.remaining, used: q.used, exhausted: q.exhausted };
  }

  getLiveEvents(sportKey?: SportKey): Promise<ProviderEvent[]> {
    return this.cached(`live:${sportKey ?? 'all'}`, this.options.cacheTtlSeconds, () =>
      this.inner.getLiveEvents(sportKey),
    );
  }

  /** Current health, as shown in the admin panel. */
  async getHealth(): Promise<ProviderHealthDto> {
    const lastSync = await this.redis.get(REDIS_KEYS.lastSync(this.key)).catch(() => null);
    return buildHealth(
      this.key,
      this.name,
      this.isSimulated,
      this.circuitState(),
      this.health,
      lastSync,
    );
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private get referenceTtl(): number {
    return this.options.referenceTtlSeconds ?? 300;
  }

  private cached<T>(name: string, ttl: number, call: () => Promise<T>): Promise<T> {
    const run = () => this.execute(name.split(':')[0] ?? name, call);
    if (ttl <= 0) return run();
    return this.cache.wrap(`provider:${this.key}:${name}`, ttl, run);
  }

  private circuitState(): CircuitState {
    const openMs = this.options.openMs ?? 30_000;
    if (this.circuit === 'OPEN' && this.now() - this.openedAt >= openMs) this.circuit = 'HALF_OPEN';
    return this.circuit;
  }

  private async execute<T>(operation: string, call: () => Promise<T>): Promise<T> {
    const state = this.circuitState();
    if (state === 'OPEN') throw new CircuitOpenError(this.key);
    if (state === 'HALF_OPEN') {
      // One probe at a time decides whether the upstream has recovered.
      if (this.probeInFlight) throw new CircuitOpenError(this.key);
      this.probeInFlight = true;
    }
    const maxAttempts = state === 'HALF_OPEN' ? 1 : this.options.maxRetries + 1;
    const base = this.options.retryBaseMs ?? 200;
    const cap = this.options.retryMaxMs ?? 5_000;
    try {
      for (let attempt = 1; ; attempt += 1) {
        const started = this.now();
        try {
          await this.acquireRateLimit();
          const result = await this.withTimeout(operation, call());
          this.recordSuccess(this.now() - started);
          return result;
        } catch (error) {
          const retryable = error instanceof ProviderError ? error.retryable : true;
          this.recordFailure(error);
          if (!retryable || attempt >= maxAttempts) throw this.wrap(operation, error);
          const wait =
            error instanceof ProviderRateLimitedError
              ? error.retryAfterMs
              : Math.random() * Math.min(cap, base * 2 ** (attempt - 1));
          await this.sleep(wait);
        }
      }
    } finally {
      if (state === 'HALF_OPEN') this.probeInFlight = false;
      await this.persistHealth().catch(() => undefined);
    }
  }

  private async acquireRateLimit(): Promise<void> {
    const result = await consumeRateLimit(
      this.redis,
      { bucket: `provider:${this.key}`, limit: this.options.rateLimitPerMinute, windowMs: 60_000 },
      'global',
    );
    if (!result.allowed) throw new ProviderRateLimitedError(result.retryAfterMs);
  }

  private withTimeout<T>(operation: string, promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ProviderTimeoutError(operation, this.options.timeoutMs)),
        this.options.timeoutMs,
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  private wrap(operation: string, error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    return new ProviderError(`${operation} failed: ${describe(error)}`, true, { cause: error });
  }

  private recordSuccess(latency: number): void {
    const h = this.health;
    h.requests += 1;
    h.consecutiveFailures = 0;
    h.avgLatencyMs =
      h.avgLatencyMs == null ? latency : Math.round(h.avgLatencyMs * 0.8 + latency * 0.2);
    h.lastSuccessAt = new Date(this.now()).toISOString();
    this.circuit = 'CLOSED';
  }

  private recordFailure(error: unknown): void {
    const h = this.health;
    h.requests += 1;
    h.failures += 1;
    h.consecutiveFailures += 1;
    h.lastErrorAt = new Date(this.now()).toISOString();
    h.lastError = describe(error).slice(0, 300);
    const threshold = this.options.failureThreshold ?? 5;
    if (this.circuit === 'HALF_OPEN' || h.consecutiveFailures >= threshold) {
      this.circuit = 'OPEN';
      this.openedAt = this.now();
    }
  }

  private async persistHealth(): Promise<void> {
    await this.redis.set(
      REDIS_KEYS.providerHealth(this.key),
      JSON.stringify({
        ...this.health,
        circuit: this.circuitState(),
        name: this.name,
        isSimulated: this.isSimulated,
      }),
      'EX',
      300,
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildHealth(
  key: string,
  name: string,
  isSimulated: boolean,
  circuit: CircuitState,
  h: HealthRecord,
  lastSyncAt: string | null,
  quota: ProviderHealthDto['quota'] = null,
): ProviderHealthDto {
  let state: ProviderState = 'UNKNOWN';
  if (circuit === 'OPEN') state = 'DOWN';
  else if (h.requests > 0) {
    state =
      h.consecutiveFailures > 0 || circuit === 'HALF_OPEN' || quota?.exhausted
        ? 'DEGRADED'
        : 'HEALTHY';
  }
  return {
    key,
    name,
    isSimulated,
    state,
    circuit,
    lastSuccessAt: h.lastSuccessAt,
    lastErrorAt: h.lastErrorAt,
    lastError: h.lastError,
    avgLatencyMs: h.avgLatencyMs,
    requests: h.requests,
    failures: h.failures,
    lastSyncAt,
    quota,
  };
}

/**
 * Reads provider health written by the worker. The API process does not talk
 * to the feed itself, so this is how the admin panel sees it.
 */
export async function readProviderHealth(
  redis: Redis,
  key: string,
): Promise<ProviderHealthDto | null> {
  const [raw, lastSync] = await Promise.all([
    redis.get(REDIS_KEYS.providerHealth(key)),
    redis.get(REDIS_KEYS.lastSync(key)),
  ]);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as HealthRecord & {
    circuit: CircuitState;
    name: string;
    isSimulated: boolean;
    quota?: ProviderHealthDto['quota'];
  };
  return buildHealth(
    key,
    parsed.name,
    parsed.isSimulated,
    parsed.circuit,
    parsed,
    lastSync,
    parsed.quota ?? null,
  );
}
