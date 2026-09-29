import { createPrismaClient } from '@storm-bet/database';
import { createRedis } from '@storm-bet/redis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MockOddsProvider,
  OddsSyncService,
  retireInactiveProviderEvents,
  type OddsProvider,
} from '../src';

const db = createPrismaClient();
const redis = createRedis(process.env.REDIS_URL!);
afterAll(async () => {
  await db.$disconnect();
  await redis.quit();
});

const HOUR = 3_600_000;

/** Wraps the mock under a unique provider key so each run owns its rows. */
function isolated(now: () => number): OddsProvider {
  const mock = new MockOddsProvider({ seed: 'sync-test', timeScale: 3, now });
  const key = `mock-test-${Math.random().toString(36).slice(2, 8)}`;
  return Object.assign(Object.create(mock) as MockOddsProvider, { key });
}

describe('OddsSyncService', () => {
  it('imports the catalogue once and writes nothing on an unchanged re-run', async () => {
    let now = Date.parse('2026-10-01T10:00:00Z');
    const provider = isolated(() => now);
    const sync = new OddsSyncService(db, redis, provider, {
      horizonHours: 3,
      lookbackHours: 1,
      now: () => now,
    });

    const first = await sync.syncCatalog();
    expect(first.createdEvents).toBeGreaterThan(10);
    expect(first.createdMarkets).toBeGreaterThan(first.createdEvents * 5);

    const events = await db.event.count({ where: { provider: provider.key } });
    expect(events).toBe(first.events);

    const second = await sync.syncCatalog();
    expect(second.createdEvents).toBe(0);
    expect(second.updatedEvents).toBe(0);
    expect(second.createdMarkets).toBe(0);
    expect(second.updatedSelections).toBe(0);

    // Prices drift between buckets: a later pre-match refresh updates versions.
    now += 30 * 60_000;
    const refreshed = await sync.syncPrematch(3);
    expect(refreshed.updatedSelections).toBeGreaterThan(0);
    const bumped = await db.selection.count({
      where: { market: { event: { provider: provider.key } }, oddsVersion: { gt: 1 } },
    });
    expect(bumped).toBeGreaterThan(0);
  });

  it('follows a fixture to the final whistle and confirms the result', async () => {
    let now = Date.parse('2026-10-02T10:00:00Z');
    const provider = isolated(() => now);
    const sync = new OddsSyncService(db, redis, provider, {
      horizonHours: 2,
      lookbackHours: 1,
      now: () => now,
    });
    await sync.syncCatalog();
    const fixture = await db.event.findFirstOrThrow({
      where: { provider: provider.key, status: 'SCHEDULED', sport: { key: 'football' } },
      orderBy: { startTime: 'asc' },
    });

    now = fixture.startTime.getTime() + 10 * 60_000;
    await sync.syncLive();
    const live = await db.event.findUniqueOrThrow({ where: { id: fixture.id } });
    expect(live.status).toBe('LIVE');

    now = fixture.startTime.getTime() + 2 * HOUR;
    await sync.syncLive();
    const done = await db.event.findUniqueOrThrow({ where: { id: fixture.id } });
    expect(done.status).toBe('FINISHED');
    expect(done.resultConfirmedAt).not.toBeNull();
    expect(done.homeScore).not.toBeNull();
    const open = await db.market.count({
      where: { eventId: fixture.id, status: { in: ['OPEN', 'SUSPENDED'] } },
    });
    expect(open).toBe(0);

    // Scorer ids in stored statistics are internal ids, never provider ids.
    const stats = done.statistics as { goalEvents: { playerId: string | null }[] };
    for (const goal of stats.goalEvents) {
      if (goal.playerId) expect(goal.playerId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('OddsSyncService markets', () => {
  it('suspends markets the feed no longer offers and reopens them when it does again', async () => {
    const now = Date.parse('2026-10-03T10:00:00Z');
    const provider = isolated(() => now);
    const sync = new OddsSyncService(db, redis, provider, {
      horizonHours: 3,
      lookbackHours: 1,
      now: () => now,
    });
    await sync.syncCatalog();
    const event = await db.event.findFirstOrThrow({
      where: { provider: provider.key, status: 'SCHEDULED', startTime: { gt: new Date(now) } },
      orderBy: { startTime: 'asc' },
    });
    const open = (await provider.getMarkets(event.externalId)).filter((m) => m.status === 'OPEN');
    expect(open.length).toBeGreaterThan(1);
    const [dropped, ...kept] = open;
    const status = async (key: string) =>
      (await db.market.findFirstOrThrow({ where: { eventId: event.id, key } })).status;

    // The feed moved a line: the old market disappears from its list.
    const report = await sync.syncMarkets(event.id, kept);
    expect(report.updatedMarkets).toBe(1);
    expect(await status(dropped!.key)).toBe('SUSPENDED');
    expect(await status(kept[0]!.key)).toBe('OPEN');

    await sync.syncMarkets(event.id, open);
    expect(await status(dropped!.key)).toBe('OPEN');

    // Nothing offered at all: nothing stays open.
    await sync.syncMarkets(event.id, []);
    const stillOpen = await db.market.count({ where: { eventId: event.id, status: 'OPEN' } });
    expect(stillOpen).toBe(0);
  });
});

describe('retireInactiveProviderEvents', () => {
  it('cancels the open events of a feed that is no longer active', async () => {
    const now = Date.parse('2026-10-04T10:00:00Z');
    const provider = isolated(() => now);
    const sync = new OddsSyncService(db, redis, provider, {
      horizonHours: 3,
      lookbackHours: 1,
      now: () => now,
    });
    await sync.syncCatalog();
    const openWhere = {
      provider: provider.key,
      status: { in: ['SCHEDULED', 'LIVE', 'SUSPENDED'] as ('SCHEDULED' | 'LIVE' | 'SUSPENDED')[] },
    };
    const open = await db.event.count({ where: openWhere });
    expect(open).toBeGreaterThan(0);

    const result = await retireInactiveProviderEvents(db, 'sportsgameodds', {
      only: [provider.key],
    });
    expect(result).toEqual({ events: open, providers: [provider.key] });
    expect(await db.event.count({ where: openWhere })).toBe(0);
    // Finished games with a confirmed result are settled normally, not cancelled.
    expect(
      await db.event.count({
        where: { provider: provider.key, status: 'FINISHED', resultConfirmedAt: { not: null } },
      }),
    ).toBeGreaterThan(0);
    expect(
      await db.market.count({ where: { event: { provider: provider.key }, status: 'OPEN' } }),
    ).toBe(0);
    const audit = await db.auditLog.findFirst({
      where: { action: 'events.provider_retired', targetId: provider.key },
    });
    expect(audit?.metadata).toMatchObject({ activeProvider: 'sportsgameodds', events: open });
    // Nothing left to do on a second start.
    expect(
      (await retireInactiveProviderEvents(db, 'sportsgameodds', { only: [provider.key] })).events,
    ).toBe(0);
  });
});

describe('stableStringify', () => {
  it('ignores key order', async () => {
    const { stableStringify } = await import('../src/util');
    expect(stableStringify({ period: 'PRE', clock: null })).toBe(
      stableStringify({ clock: null, period: 'PRE' }),
    );
    expect(stableStringify({ a: [1, { y: 1, x: 2 }] })).toBe('{"a":[1,{"x":2,"y":1}]}');
  });
});
