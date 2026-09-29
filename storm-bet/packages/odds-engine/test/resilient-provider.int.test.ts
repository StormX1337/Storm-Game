import { createRedis } from '@storm-bet/redis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CircuitOpenError,
  ProviderError,
  ProviderTimeoutError,
  ResilientOddsProvider,
  type OddsProvider,
  type ProviderSport,
} from '../src';

const redis = createRedis(process.env.REDIS_URL!);
afterAll(() => redis.quit());

/** A scriptable upstream: each call pops the next behaviour. */
function fakeProvider(script: ('ok' | 'fail' | 'fatal' | 'hang')[]) {
  let calls = 0;
  const provider: OddsProvider & { calls: () => number } = {
    key: `fake-${Math.random().toString(36).slice(2)}`,
    name: 'Fake',
    isSimulated: true,
    calls: () => calls,
    async getSports(): Promise<ProviderSport[]> {
      const step = script[Math.min(calls, script.length - 1)];
      calls += 1;
      if (step === 'fail') throw new ProviderError('upstream 503', true);
      if (step === 'fatal') throw new ProviderError('bad credentials', false);
      if (step === 'hang') await new Promise((r) => setTimeout(r, 1_000));
      return [{ key: 'football', name: 'Fußball' }];
    },
    getLeagues: async () => [],
    getEvents: async () => [],
    getEvent: async () => null,
    getMarkets: async () => [],
    getLiveEvents: async () => [],
  };
  return provider;
}

const base = {
  timeoutMs: 100,
  maxRetries: 2,
  retryBaseMs: 1,
  rateLimitPerMinute: 10_000,
  cacheTtlSeconds: 0,
  referenceTtlSeconds: 0,
  sleep: async () => undefined,
};

describe('ResilientOddsProvider', () => {
  it('retries transient failures and succeeds', async () => {
    const inner = fakeProvider(['fail', 'fail', 'ok']);
    const provider = new ResilientOddsProvider(inner, redis, base);
    await expect(provider.getSports()).resolves.toHaveLength(1);
    expect(inner.calls()).toBe(3);
    const health = await provider.getHealth();
    expect(health.failures).toBe(2);
    expect(health.state).toBe('HEALTHY');
  });

  it('does not retry permanent errors', async () => {
    const inner = fakeProvider(['fatal', 'ok']);
    const provider = new ResilientOddsProvider(inner, redis, base);
    await expect(provider.getSports()).rejects.toThrow('bad credentials');
    expect(inner.calls()).toBe(1);
  });

  it('times out hung calls', async () => {
    const inner = fakeProvider(['hang']);
    const provider = new ResilientOddsProvider(inner, redis, { ...base, maxRetries: 0 });
    await expect(provider.getSports()).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('opens the circuit after repeated failures and probes after the cool-down', async () => {
    let now = 1_000_000;
    const inner = fakeProvider(['fail', 'fail', 'fail', 'ok']);
    const provider = new ResilientOddsProvider(inner, redis, {
      ...base,
      maxRetries: 0,
      failureThreshold: 3,
      openMs: 10_000,
      now: () => now,
    });
    for (let i = 0; i < 3; i += 1) await expect(provider.getSports()).rejects.toThrow();
    await expect(provider.getSports()).rejects.toBeInstanceOf(CircuitOpenError);
    expect(inner.calls()).toBe(3);
    expect((await provider.getHealth()).state).toBe('DOWN');
    now += 10_000;
    await expect(provider.getSports()).resolves.toHaveLength(1);
    expect((await provider.getHealth()).circuit).toBe('CLOSED');
  });

  it('enforces the shared rate limit', async () => {
    const inner = fakeProvider(['ok']);
    const provider = new ResilientOddsProvider(inner, redis, {
      ...base,
      maxRetries: 0,
      rateLimitPerMinute: 2,
    });
    await provider.getSports();
    await provider.getSports();
    await expect(provider.getSports()).rejects.toThrow(/rate limit/);
  });

  it('serves repeated reads from the cache', async () => {
    const inner = fakeProvider(['ok']);
    const provider = new ResilientOddsProvider(inner, redis, { ...base, referenceTtlSeconds: 30 });
    await provider.getSports();
    await provider.getSports();
    expect(inner.calls()).toBe(1);
  });
});
