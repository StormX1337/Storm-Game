import { randomUUID } from 'node:crypto';
import { REDIS_KEYS } from '@storm-bet/config/constants';
import { oddsToMilli, Prisma, type Event, type PrismaClient } from '@storm-bet/database';
import { publishRealtime, type Redis } from '@storm-bet/redis';
import type { MarketStatus, RealtimeMessage, SelectionStatus } from '@storm-bet/types';
import { MARKET_DEFINITIONS } from '@storm-bet/types';
import type { OddsProvider, ProviderEvent, ProviderMarket, ProviderTeam } from '../provider';
import { mapLimit, silentLogger, stableStringify, type Logger } from '../util';

export interface SyncOptions {
  /** How far ahead fixtures are imported. */
  horizonHours: number;
  /** Finished fixtures younger than this are still refreshed (late results). */
  lookbackHours: number;
  concurrency?: number;
  now?: () => number;
  logger?: Logger;
}

export interface SyncReport {
  events: number;
  createdEvents: number;
  updatedEvents: number;
  createdMarkets: number;
  updatedSelections: number;
  updatedMarkets: number;
  failures: number;
}

const emptyReport = (): SyncReport => ({
  events: 0,
  createdEvents: 0,
  updatedEvents: 0,
  createdMarkets: 0,
  updatedSelections: 0,
  updatedMarkets: 0,
  failures: 0,
});

function merge(a: SyncReport, b: SyncReport): SyncReport {
  return {
    events: a.events + b.events,
    createdEvents: a.createdEvents + b.createdEvents,
    updatedEvents: a.updatedEvents + b.updatedEvents,
    createdMarkets: a.createdMarkets + b.createdMarkets,
    updatedSelections: a.updatedSelections + b.updatedSelections,
    updatedMarkets: a.updatedMarkets + b.updatedMarkets,
    failures: a.failures + b.failures,
  };
}

const FROZEN_STATUSES = new Set(['FINISHED', 'CANCELLED']);

/**
 * Mirrors the provider feed into PostgreSQL, which stays the only source of
 * truth for betting. Only differences are written; every write that a player
 * could see is also published for the live UI.
 *
 * Row locks are always taken in the same order as bet placement takes them
 * (markets before selections, each sorted by id), so a sync and a placement
 * touching the same rows queue instead of deadlocking.
 */
export class OddsSyncService {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly concurrency: number;
  private sportIds = new Map<string, string>();
  private leagueIds = new Map<string, string>();

  constructor(
    private readonly db: PrismaClient,
    private readonly redis: Redis,
    private readonly provider: OddsProvider,
    private readonly options: SyncOptions,
  ) {
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
    this.concurrency = options.concurrency ?? 8;
  }

  get providerKey(): string {
    return this.provider.key;
  }

  /** Reference data and the fixture list within the horizon. */
  async syncCatalog(): Promise<SyncReport> {
    await this.syncReferenceData();
    const now = this.now();
    const events = await this.provider.getEvents({
      from: new Date(now - this.options.lookbackHours * 3_600_000).toISOString(),
      to: new Date(now + this.options.horizonHours * 3_600_000).toISOString(),
    });
    const report = await this.syncEvents(events, { refreshMarketsFor: 'new' });
    await this.markSynced();
    return report;
  }

  /** In-play fixtures, plus fixtures the database still believes are live. */
  async syncLive(): Promise<SyncReport> {
    if (this.sportIds.size === 0) await this.syncReferenceData();
    const live = await this.provider.getLiveEvents();
    const seen = new Set(live.map((e) => e.externalId));
    const stale = await this.db.event.findMany({
      where: {
        provider: this.provider.key,
        OR: [
          { status: 'LIVE' },
          { status: 'SCHEDULED', startTime: { lte: new Date(this.now()) } },
          { status: 'FINISHED', resultConfirmedAt: null },
        ],
      },
      select: { externalId: true },
      take: 200,
    });
    const extra = await mapLimit(
      stale.filter((e) => !seen.has(e.externalId)),
      this.concurrency,
      (e) => this.provider.getEvent(e.externalId),
    );
    const events = [
      ...live,
      ...extra.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : [])),
    ];
    const report = await this.syncEvents(events, { refreshMarketsFor: 'all' });
    report.failures += extra.filter((r) => r.status === 'rejected').length;
    await this.markSynced();
    return report;
  }

  /** Refreshes prices of fixtures starting soon. */
  async syncPrematch(withinHours: number): Promise<SyncReport> {
    const now = this.now();
    const events = await this.db.event.findMany({
      where: {
        provider: this.provider.key,
        status: 'SCHEDULED',
        settledAt: null,
        startTime: { gt: new Date(now), lte: new Date(now + withinHours * 3_600_000) },
      },
      select: { id: true, externalId: true },
      orderBy: { startTime: 'asc' },
      take: 500,
    });
    const results = await mapLimit(events, this.concurrency, async (event) => {
      const markets = await this.provider.getMarkets(event.externalId);
      return this.syncMarkets(event.id, markets);
    });
    let report = emptyReport();
    for (const r of results) {
      if (r.status === 'fulfilled') report = merge(report, r.value);
      else {
        report.failures += 1;
        this.logger.warn({ err: String(r.reason) }, 'prematch market refresh failed');
      }
    }
    report.events = events.length;
    await this.markSynced();
    return report;
  }

  // ─── reference data ───────────────────────────────────────────────────────

  private async syncReferenceData(): Promise<void> {
    const sports = await this.provider.getSports();
    for (const [index, sport] of sports.entries()) {
      const row = await this.db.sport.upsert({
        where: { key: sport.key },
        create: { key: sport.key, name: sport.name, sortOrder: index },
        update: {},
        select: { id: true },
      });
      this.sportIds.set(sport.key, row.id);
    }
    const leagues = await this.provider.getLeagues();
    for (const [index, league] of leagues.entries()) {
      const sportId = this.sportIds.get(league.sportKey);
      if (!sportId) continue;
      const row = await this.db.league.upsert({
        where: {
          provider_externalId: { provider: this.provider.key, externalId: league.externalId },
        },
        create: {
          sportId,
          provider: this.provider.key,
          externalId: league.externalId,
          name: league.name,
          country: league.country,
          sortOrder: index,
        },
        update: { name: league.name, country: league.country },
        select: { id: true },
      });
      this.leagueIds.set(league.externalId, row.id);
    }
  }

  private async ensureTeams(events: ProviderEvent[]): Promise<{
    teams: Map<string, string>;
    players: Map<string, string>;
  }> {
    const teamsByExternal = new Map<string, { team: ProviderTeam; sportKey: string }>();
    for (const event of events) {
      teamsByExternal.set(event.home.externalId, { team: event.home, sportKey: event.sportKey });
      teamsByExternal.set(event.away.externalId, { team: event.away, sportKey: event.sportKey });
    }
    const externalIds = [...teamsByExternal.keys()];
    const existing = await this.db.team.findMany({
      where: { provider: this.provider.key, externalId: { in: externalIds } },
      select: { id: true, externalId: true },
    });
    const teams = new Map(existing.map((t) => [t.externalId, t.id]));
    const missing = externalIds.filter((id) => !teams.has(id));
    if (missing.length) {
      const rows = missing.flatMap((externalId) => {
        const entry = teamsByExternal.get(externalId);
        const sportId = entry && this.sportIds.get(entry.sportKey);
        if (!entry || !sportId) return [];
        const id = randomUUID();
        teams.set(externalId, id);
        return [
          {
            id,
            sportId,
            provider: this.provider.key,
            externalId,
            name: entry.team.name,
            shortName: entry.team.shortName,
          },
        ];
      });
      await this.db.team.createMany({ data: rows, skipDuplicates: true });
      // A concurrent sync may have won the race; read back the real ids.
      const confirmed = await this.db.team.findMany({
        where: { provider: this.provider.key, externalId: { in: missing } },
        select: { id: true, externalId: true },
      });
      for (const t of confirmed) teams.set(t.externalId, t.id);
    }

    const playerDefs = [...teamsByExternal.values()].flatMap(({ team }) =>
      team.players.map((p) => ({ ...p, teamExternalId: team.externalId })),
    );
    const players = new Map<string, string>();
    if (playerDefs.length) {
      const known = await this.db.player.findMany({
        where: {
          provider: this.provider.key,
          externalId: { in: playerDefs.map((p) => p.externalId) },
        },
        select: { id: true, externalId: true },
      });
      for (const p of known) players.set(p.externalId, p.id);
      const newPlayers = playerDefs.filter((p) => !players.has(p.externalId));
      if (newPlayers.length) {
        await this.db.player.createMany({
          data: newPlayers.flatMap((p) => {
            const teamId = teams.get(p.teamExternalId);
            if (!teamId) return [];
            return [
              {
                id: randomUUID(),
                teamId,
                provider: this.provider.key,
                externalId: p.externalId,
                name: p.name,
                position: p.position,
              },
            ];
          }),
          skipDuplicates: true,
        });
        const confirmed = await this.db.player.findMany({
          where: {
            provider: this.provider.key,
            externalId: { in: newPlayers.map((p) => p.externalId) },
          },
          select: { id: true, externalId: true },
        });
        for (const p of confirmed) players.set(p.externalId, p.id);
      }
    }
    return { teams, players };
  }

  // ─── events ───────────────────────────────────────────────────────────────

  private async syncEvents(
    events: ProviderEvent[],
    options: { refreshMarketsFor: 'new' | 'all' },
  ): Promise<SyncReport> {
    const report = emptyReport();
    report.events = events.length;
    if (events.length === 0) return report;
    if (events.some((e) => !this.leagueIds.has(e.leagueExternalId))) await this.syncReferenceData();
    const { teams, players } = await this.ensureTeams(events);

    const existing = await this.db.event.findMany({
      where: { provider: this.provider.key, externalId: { in: events.map((e) => e.externalId) } },
    });
    const byExternal = new Map(existing.map((e) => [e.externalId, e]));
    const created: { id: string; externalId: string }[] = [];
    const toCreate: Prisma.EventCreateManyInput[] = [];
    const realtime: RealtimeMessage[] = [];

    for (const event of events) {
      const sportId = this.sportIds.get(event.sportKey);
      const leagueId = this.leagueIds.get(event.leagueExternalId);
      const homeTeamId = teams.get(event.home.externalId);
      const awayTeamId = teams.get(event.away.externalId);
      if (!sportId || !leagueId || !homeTeamId || !awayTeamId) {
        report.failures += 1;
        continue;
      }
      const values = this.eventValues(event, players);
      const current = byExternal.get(event.externalId);
      if (!current) {
        const id = randomUUID();
        const { translatedStatistics: _stats, ...columns } = values;
        toCreate.push({
          id,
          sportId,
          leagueId,
          homeTeamId,
          awayTeamId,
          provider: this.provider.key,
          externalId: event.externalId,
          startTime: new Date(event.startTime),
          ...columns,
          resultConfirmedAt: event.resultFinal ? new Date(this.now()) : null,
        });
        created.push({ id, externalId: event.externalId });
        continue;
      }
      if (current.settledAt || (FROZEN_STATUSES.has(current.status) && current.resultConfirmedAt)) {
        continue;
      }
      const changes = this.diffEvent(current, event, values);
      if (changes) {
        const updated = await this.db.event.update({ where: { id: current.id }, data: changes });
        report.updatedEvents += 1;
        realtime.push({
          type: 'event',
          eventId: updated.id,
          sportKey: event.sportKey,
          status: updated.status,
          isActive: updated.isActive,
          score:
            values.homeScore == null
              ? null
              : { home: values.homeScore, away: values.awayScore ?? 0 },
          liveState: event.liveState,
          statistics: values.translatedStatistics,
        });
      }
    }
    if (toCreate.length) {
      const result = await this.db.event.createMany({ data: toCreate, skipDuplicates: true });
      report.createdEvents += result.count;
    }
    await publishRealtime(this.redis, realtime).catch((err) =>
      this.logger.warn({ err: String(err) }, 'realtime publish failed'),
    );

    const refresh =
      options.refreshMarketsFor === 'all'
        ? [
            ...created,
            ...existing
              .filter((e) => !e.settledAt)
              .map((e) => ({ id: e.id, externalId: e.externalId })),
          ]
        : created;
    // Existing events without any market (e.g. after a failed first import).
    if (options.refreshMarketsFor === 'new' && existing.length) {
      const bare = await this.db.event.findMany({
        where: { id: { in: existing.map((e) => e.id) }, markets: { none: {} }, settledAt: null },
        select: { id: true, externalId: true },
      });
      refresh.push(...bare);
    }
    const results = await mapLimit(refresh, this.concurrency, async (event) =>
      this.syncMarkets(event.id, await this.provider.getMarkets(event.externalId)),
    );
    let merged = report;
    for (const r of results) {
      if (r.status === 'fulfilled') merged = merge(merged, r.value);
      else {
        merged.failures += 1;
        this.logger.warn({ err: String(r.reason) }, 'market sync failed');
      }
    }
    return merged;
  }

  private eventValues(event: ProviderEvent, players: Map<string, string>) {
    let statistics = event.statistics;
    if (statistics?.sport === 'football') {
      statistics = {
        ...statistics,
        goalEvents: statistics.goalEvents.map((g) => ({
          ...g,
          playerId: g.playerId ? (players.get(g.playerId) ?? null) : null,
        })),
      };
    }
    return {
      status: event.status,
      homeScore: event.score?.home ?? null,
      awayScore: event.score?.away ?? null,
      liveState: (event.liveState ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
      statistics: (statistics ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
      translatedStatistics: statistics,
    };
  }

  private diffEvent(
    current: Event,
    event: ProviderEvent,
    values: ReturnType<OddsSyncService['eventValues']>,
  ): Prisma.EventUpdateInput | null {
    const changes: Prisma.EventUpdateInput = {};
    const json = (v: unknown) => stableStringify(v === Prisma.DbNull ? null : v);
    if (current.status !== values.status) changes.status = values.status;
    if (current.homeScore !== values.homeScore) changes.homeScore = values.homeScore;
    if (current.awayScore !== values.awayScore) changes.awayScore = values.awayScore;
    if (json(current.liveState) !== json(values.liveState)) changes.liveState = values.liveState;
    if (json(current.statistics) !== json(values.statistics))
      changes.statistics = values.statistics;
    if (current.startTime.toISOString() !== new Date(event.startTime).toISOString()) {
      changes.startTime = new Date(event.startTime);
    }
    if (event.resultFinal && !current.resultConfirmedAt)
      changes.resultConfirmedAt = new Date(this.now());
    return Object.keys(changes).length ? changes : null;
  }

  // ─── markets ──────────────────────────────────────────────────────────────

  async syncMarkets(eventId: string, markets: ProviderMarket[]): Promise<SyncReport> {
    const report = emptyReport();
    if (markets.length === 0) return report;
    const existing = await this.db.market.findMany({
      where: { eventId },
      include: { selections: true },
    });
    const byKey = new Map(existing.map((m) => [m.key, m]));

    const newMarkets: Prisma.MarketCreateManyInput[] = [];
    const newSelections: Prisma.SelectionCreateManyInput[] = [];
    const marketUpdates: { id: string; status: MarketStatus; reason: string | null }[] = [];
    const selectionUpdates: {
      id: string;
      odds: number;
      status: SelectionStatus;
      reason: string | null;
    }[] = [];

    const playerIds = await this.playerIdsFor(markets);

    for (const market of markets) {
      const definition = MARKET_DEFINITIONS[market.type];
      const current = byKey.get(market.key);
      let marketId: string;
      if (!current) {
        marketId = randomUUID();
        newMarkets.push({
          id: marketId,
          eventId,
          key: market.key,
          type: market.type,
          name: market.name,
          line: market.line == null ? null : new Prisma.Decimal(market.line),
          status: market.status,
          sortOrder: definition.sortOrder * 100 + Math.round((market.line ?? 0) * 2),
        });
      } else {
        marketId = current.id;
        if (current.status !== 'SETTLED' && current.status !== market.status) {
          marketUpdates.push({
            id: current.id,
            status: market.status,
            reason: market.suspensionReason,
          });
        }
      }
      const known = new Map((current?.selections ?? []).map((s) => [s.key, s]));
      market.selections.forEach((selection, index) => {
        const reason = selection.status === 'SUSPENDED' ? (market.suspensionReason ?? null) : null;
        const existingSelection = known.get(selection.key);
        if (!existingSelection) {
          newSelections.push({
            id: randomUUID(),
            marketId,
            key: selection.key,
            name: selection.name,
            outcome: selection.outcome,
            playerId: selection.playerExternalId
              ? (playerIds.get(selection.playerExternalId) ?? null)
              : null,
            odds: new Prisma.Decimal(selection.odds.toFixed(3)),
            status: selection.status,
            suspensionReason: reason,
            sortOrder: index,
          });
          return;
        }
        if (current?.status === 'SETTLED') return;
        const oddsChanged =
          oddsToMilli(existingSelection.odds) !== Math.round(selection.odds * 1000);
        if (oddsChanged || existingSelection.status !== selection.status) {
          selectionUpdates.push({
            id: existingSelection.id,
            odds: selection.odds,
            status: selection.status,
            reason,
          });
        }
      });
    }

    if (newMarkets.length) {
      const result = await this.db.market.createMany({ data: newMarkets, skipDuplicates: true });
      report.createdMarkets += result.count;
    }
    if (newSelections.length) {
      await this.db.selection.createMany({ data: newSelections, skipDuplicates: true });
    }
    if (marketUpdates.length === 0 && selectionUpdates.length === 0) return report;

    const { changedMarkets, changedSelections } = await this.applyUpdates(
      marketUpdates,
      selectionUpdates,
    );
    report.updatedMarkets += changedMarkets.length;
    report.updatedSelections += changedSelections.length;

    const messages: RealtimeMessage[] = [];
    if (changedMarkets.length) {
      messages.push({ type: 'market', eventId, markets: changedMarkets });
    }
    if (changedSelections.length) {
      messages.push({ type: 'odds', eventId, selections: changedSelections });
    }
    await publishRealtime(this.redis, messages).catch((err) =>
      this.logger.warn({ err: String(err) }, 'realtime publish failed'),
    );
    return report;
  }

  private async playerIdsFor(markets: ProviderMarket[]): Promise<Map<string, string>> {
    const externalIds = markets.flatMap((m) =>
      m.selections.flatMap((s) => (s.playerExternalId ? [s.playerExternalId] : [])),
    );
    if (externalIds.length === 0) return new Map();
    const rows = await this.db.player.findMany({
      where: { provider: this.provider.key, externalId: { in: externalIds } },
      select: { id: true, externalId: true },
    });
    return new Map(rows.map((r) => [r.externalId, r.id]));
  }

  private async applyUpdates(
    marketUpdates: { id: string; status: MarketStatus; reason: string | null }[],
    selectionUpdates: {
      id: string;
      odds: number;
      status: SelectionStatus;
      reason: string | null;
    }[],
  ) {
    return this.db.$transaction(async (tx) => {
      let changedMarkets: { id: string; status: MarketStatus }[] = [];
      if (marketUpdates.length) {
        const ids = marketUpdates.map((u) => u.id).sort();
        await tx.$queryRaw`SELECT "id" FROM "markets" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE`;
        changedMarkets = await tx.$queryRaw<{ id: string; status: MarketStatus }[]>`
          UPDATE "markets" AS m
          SET "status" = v.status::"MarketStatus", "updated_at" = now()
          FROM unnest(${marketUpdates.map((u) => u.id)}::uuid[], ${marketUpdates.map((u) => u.status)}::text[])
            AS v(id, status)
          WHERE m."id" = v.id AND m."status" <> 'SETTLED' AND m."status"::text <> v.status
          RETURNING m."id", m."status"::text AS "status"`;
      }
      let changedSelections: {
        id: string;
        marketId: string;
        odds: number;
        status: SelectionStatus;
        oddsVersion: number;
      }[] = [];
      if (selectionUpdates.length) {
        const ids = selectionUpdates.map((u) => u.id).sort();
        await tx.$queryRaw`SELECT "id" FROM "selections" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE`;
        const rows = await tx.$queryRaw<
          {
            id: string;
            market_id: string;
            odds: Prisma.Decimal;
            status: SelectionStatus;
            odds_version: number;
          }[]
        >`
          UPDATE "selections" AS s
          SET "odds" = v.odds,
              "status" = v.status::"SelectionStatus",
              "suspension_reason" = v.reason,
              "odds_version" = s."odds_version" + 1,
              "odds_updated_at" = now(),
              "updated_at" = now()
          FROM unnest(
            ${selectionUpdates.map((u) => u.id)}::uuid[],
            ${selectionUpdates.map((u) => u.odds.toFixed(3))}::numeric[],
            ${selectionUpdates.map((u) => u.status)}::text[],
            ${selectionUpdates.map((u) => u.reason)}::text[]
          ) AS v(id, odds, status, reason)
          WHERE s."id" = v.id AND (s."odds" <> v.odds OR s."status"::text <> v.status)
          RETURNING s."id", s."market_id", s."odds", s."status"::text AS "status", s."odds_version"`;
        changedSelections = rows.map((r) => ({
          id: r.id,
          marketId: r.market_id,
          odds: oddsToMilli(r.odds) / 1000,
          status: r.status,
          oddsVersion: r.odds_version,
        }));
      }
      return { changedMarkets, changedSelections };
    });
  }

  private async markSynced(): Promise<void> {
    await this.redis
      .set(REDIS_KEYS.lastSync(this.provider.key), new Date(this.now()).toISOString(), 'EX', 3_600)
      .catch(() => undefined);
  }
}
