import { randomUUID } from 'node:crypto';
import {
  BET_INCLUDE,
  toBetDto,
  toTransactionDto,
  toWalletDto,
  TRANSACTION_INCLUDE,
  type SettlementService,
} from '@storm-bet/betting-engine';
import { REDIS_KEYS } from '@storm-bet/config/constants';
import {
  milliToDecimal,
  moneyToNumber,
  oddsToMilli,
  Prisma,
  recordAudit,
  withTransaction,
  type AuditActor,
  type PrismaClient,
} from '@storm-bet/database';
import { isSimulatedProvider, PROVIDER_INFO, readProviderHealth } from '@storm-bet/odds-engine';
import { publishRealtime, type JsonCache, type Redis } from '@storm-bet/redis';
import { verifyPassword } from '@storm-bet/security';
import {
  AppError,
  MARKET_DEFINITIONS,
  marketKey,
  type AdminBetDetailDto,
  type AdminBetDto,
  type AdminCatalogDto,
  type AdminEventDto,
  type AdminEventListItemDto,
  type AdminOverviewDto,
  type AdminTransactionDto,
  type AdminUserDetailDto,
  type AdminUserDto,
  type AuditLogDto,
  type EventStatistics,
  type MarketType,
  type Outcome,
  type Paginated,
  type ProviderHealthDto,
  type SportKey,
  type SystemHealthDto,
  type UserRole,
} from '@storm-bet/types';
import {
  parseLiveState,
  parseStatistics,
  type AdminCreateEventInput,
  type z,
  type adminAuditListQuery,
  type adminBetListQuery,
  type adminEventListQuery,
  type adminMarketActionSchema,
  type adminSelectionUpdateSchema,
  type adminSetRoleSchema,
  type adminTransactionListQuery,
  type adminUserListQuery,
  type EVENT_ACTIONS,
} from '@storm-bet/validation';
import type { Queue } from 'bullmq';
import { cursorArgs, page } from '../lib/pagination';
import type { AccountService } from './account';
import { toSessionUser } from './auth';
import { effectiveEventStatus, toMarketDto } from './catalog';
import type { SessionService } from './sessions';

const userRef = (u: { id: string; email: string; displayName: string }) => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
});

function toAuditDto(
  row: Prisma.AuditLogGetPayload<{ include: { actor: { select: { email: true } } } }>,
): AuditLogDto {
  return {
    id: row.id,
    actorId: row.actorId,
    actorEmail: row.actor?.email ?? null,
    actorRole: row.actorRole,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    ip: row.ip,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

function scoreFrom(stats: EventStatistics): { home: number; away: number } {
  switch (stats.sport) {
    case 'football':
      return stats.goals;
    case 'tennis':
      return stats.setsWon;
    case 'basketball':
      return stats.points;
  }
}

function selectionName(
  type: MarketType,
  outcome: Outcome,
  line: number | null,
  home: string,
  away: string,
  player?: string,
): string {
  const fmt = (v: number) => (v > 0 ? `+${v}` : `${v}`);
  switch (outcome) {
    case 'HOME':
      return MARKET_DEFINITIONS[type].kind === 'HANDICAP' && line != null
        ? `${home} ${fmt(line)}`
        : home;
    case 'AWAY':
      return MARKET_DEFINITIONS[type].kind === 'HANDICAP' && line != null
        ? `${away} ${fmt(-line)}`
        : away;
    case 'DRAW':
      return 'Unentschieden';
    case 'HOME_OR_DRAW':
      return `${home} oder Unentschieden`;
    case 'HOME_OR_AWAY':
      return `${home} oder ${away}`;
    case 'DRAW_OR_AWAY':
      return `Unentschieden oder ${away}`;
    case 'OVER':
      return `Über ${line}`;
    case 'UNDER':
      return `Unter ${line}`;
    case 'YES':
      return 'Ja';
    case 'NO':
      return 'Nein';
    case 'SETS_2_0':
      return `${home} 2:0`;
    case 'SETS_2_1':
      return `${home} 2:1`;
    case 'SETS_1_2':
      return `${away} 2:1`;
    case 'SETS_0_2':
      return `${away} 2:0`;
    case 'PLAYER':
      return player ?? 'Spieler';
  }
}

export class AdminService {
  constructor(
    private readonly db: PrismaClient,
    private readonly redis: Redis,
    private readonly cache: JsonCache,
    private readonly sessions: SessionService,
    private readonly accounts: AccountService,
    private readonly settlement: SettlementService,
    private readonly queues: Queue[],
    private readonly now: () => Date,
    private readonly oddsProvider: string,
  ) {}

  // ─── overview & health ────────────────────────────────────────────────────

  async systemHealth(): Promise<SystemHealthDto> {
    const time = async (fn: () => Promise<unknown>) => {
      const started = performance.now();
      try {
        await fn();
        return { ok: true, latencyMs: Math.round(performance.now() - started), detail: null };
      } catch (error) {
        return {
          ok: false,
          latencyMs: null,
          detail: error instanceof Error ? error.message.slice(0, 120) : 'Fehler',
        };
      }
    };
    const [database, redis] = await Promise.all([
      time(() => this.db.$queryRaw`SELECT 1`),
      time(() => this.redis.ping()),
    ]);
    const heartbeat = await this.redis.get(REDIS_KEYS.workerHeartbeat).catch(() => null);
    const workerOk = heartbeat !== null && this.now().getTime() - Date.parse(heartbeat) < 60_000;
    const queues = await Promise.all(
      this.queues.map(async (q) => {
        try {
          const counts = await q.getJobCounts('waiting', 'active', 'failed', 'delayed');
          return {
            name: q.name,
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            failed: counts.failed ?? 0,
            delayed: counts.delayed ?? 0,
          };
        } catch {
          return { name: q.name, waiting: 0, active: 0, failed: 0, delayed: 0 };
        }
      }),
    );
    const components = [
      { name: 'PostgreSQL', ...database },
      { name: 'Redis', ...redis },
      {
        name: 'Worker',
        ok: workerOk,
        latencyMs: null,
        detail: heartbeat ? `letzter Heartbeat ${heartbeat}` : 'kein Heartbeat',
      },
    ];
    const status = !database.ok ? 'down' : components.every((c) => c.ok) ? 'ok' : 'degraded';
    return {
      status,
      components,
      worker: { lastHeartbeatAt: heartbeat, ok: workerOk },
      queues,
      time: this.now().toISOString(),
    };
  }

  async providers(): Promise<ProviderHealthDto[]> {
    const out: ProviderHealthDto[] = [];
    for (const key of [this.oddsProvider]) {
      out.push(
        (await readProviderHealth(this.redis, key).catch(() => null)) ?? {
          key,
          name: PROVIDER_INFO[key]?.name ?? key,
          isSimulated: isSimulatedProvider(key),
          state: 'UNKNOWN',
          circuit: 'CLOSED',
          lastSuccessAt: null,
          lastErrorAt: null,
          lastError: null,
          avgLatencyMs: null,
          requests: 0,
          failures: 0,
          lastSyncAt: null,
          quota: null,
        },
      );
    }
    return out;
  }

  async overview(): Promise<AdminOverviewDto> {
    const now = this.now();
    const dayStart = new Date(now.getTime() - 24 * 3_600_000);
    const [
      users,
      active,
      locked,
      newToday,
      events,
      live,
      upcoming,
      awaiting,
      bets,
      pending,
      placedToday,
      staked,
      txToday,
      system,
      providers,
    ] = await Promise.all([
      this.db.user.count(),
      this.db.user.count({ where: { status: 'ACTIVE' } }),
      this.db.user.count({ where: { status: 'LOCKED' } }),
      this.db.user.count({ where: { createdAt: { gt: dayStart } } }),
      this.db.event.count(),
      this.db.event.count({ where: { status: 'LIVE' } }),
      this.db.event.count({ where: { status: 'SCHEDULED', startTime: { gt: now } } }),
      this.db.event.count({
        where: { settledAt: null, OR: [{ status: 'FINISHED' }, { status: 'CANCELLED' }] },
      }),
      this.db.bet.count(),
      this.db.bet.count({ where: { status: 'PENDING' } }),
      this.db.bet.count({ where: { placedAt: { gt: dayStart } } }),
      this.db.bet.aggregate({ where: { placedAt: { gt: dayStart } }, _sum: { stake: true } }),
      this.db.transaction.count({ where: { createdAt: { gt: dayStart } } }),
      this.systemHealth(),
      this.providers(),
    ]);
    return {
      users: { total: users, active, locked, newToday },
      events: { total: events, live, upcoming, awaitingSettlement: awaiting },
      bets: {
        total: bets,
        pending,
        placedToday,
        stakedToday: moneyToNumber(staked._sum.stake ?? 0n),
      },
      transactions: { today: txToday },
      system,
      providers,
    };
  }

  // ─── users ────────────────────────────────────────────────────────────────

  private async userDto(id: string): Promise<AdminUserDto> {
    const user = await this.db.user.findUnique({
      where: { id },
      include: { wallet: true, _count: { select: { bets: true } } },
    });
    if (!user) throw new AppError('NOT_FOUND', 'Nutzer nicht gefunden.');
    return {
      ...toSessionUser(user),
      country: user.country,
      dateOfBirth: user.dateOfBirth?.toISOString().slice(0, 10) ?? null,
      kycStatus: user.kycStatus,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      lockedReason: user.lockedReason,
      lockedAt: user.lockedAt?.toISOString() ?? null,
      wallet: user.wallet ? toWalletDto(user.wallet) : null,
      betCount: user._count.bets,
    };
  }

  async listUsers(query: z.infer<typeof adminUserListQuery>): Promise<Paginated<AdminUserDto>> {
    const where: Prisma.UserWhereInput = {};
    if (query.role) where.role = query.role;
    if (query.status) where.status = query.status;
    if (query.q) {
      const q = query.q;
      where.OR = [
        { email: { contains: q.toLowerCase() } },
        { displayName: { contains: q, mode: 'insensitive' } },
        ...(/^[0-9a-f-]{36}$/i.test(q) ? [{ id: q }] : []),
      ];
    }
    const rows = await this.db.user.findMany({
      where,
      include: { wallet: true, _count: { select: { bets: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(query.cursor, query.limit),
    });
    return page(rows, query.limit, (user) => ({
      ...toSessionUser(user),
      country: user.country,
      dateOfBirth: user.dateOfBirth?.toISOString().slice(0, 10) ?? null,
      kycStatus: user.kycStatus,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      lockedReason: user.lockedReason,
      lockedAt: user.lockedAt?.toISOString() ?? null,
      wallet: user.wallet ? toWalletDto(user.wallet) : null,
      betCount: user._count.bets,
    }));
  }

  async getUser(id: string): Promise<AdminUserDetailDto> {
    const [user, limits, selfExclusion, activeSessions] = await Promise.all([
      this.userDto(id),
      this.accounts.limits(id),
      this.accounts.selfExclusion(id),
      this.db.session.count({
        where: { userId: id, revokedAt: null, expiresAt: { gt: this.now() } },
      }),
    ]);
    return { ...user, limits, selfExclusion, activeSessions };
  }

  async setRole(
    actor: AuditActor & { id: string },
    userId: string,
    input: z.infer<typeof adminSetRoleSchema>,
  ) {
    if (actor.id === userId)
      throw new AppError('FORBIDDEN', 'Du kannst deine eigene Rolle nicht ändern.');
    const actorRow = await this.db.user.findUniqueOrThrow({ where: { id: actor.id } });
    if (!(await verifyPassword(actorRow.passwordHash, input.confirmPassword))) {
      throw new AppError('VALIDATION_ERROR', 'Passwort-Bestätigung fehlgeschlagen.', {
        details: { fields: { confirmPassword: 'Passwort ist falsch' } },
      });
    }
    const target = await this.db.user.findUnique({ where: { id: userId } });
    if (!target) throw new AppError('NOT_FOUND', 'Nutzer nicht gefunden.');
    if (target.role === input.role) return this.userDto(userId);
    if (target.role === 'ADMIN') {
      const admins = await this.db.user.count({ where: { role: 'ADMIN', status: 'ACTIVE' } });
      if (admins <= 1)
        throw new AppError(
          'CONFLICT',
          'Der letzte aktive Administrator kann nicht herabgestuft werden.',
        );
    }
    await withTransaction(this.db, async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { role: input.role as UserRole } });
      await recordAudit(tx, actor, {
        action: 'admin.user_role_changed',
        targetType: 'user',
        targetId: userId,
        metadata: { from: target.role, to: input.role, reason: input.reason },
      });
    });
    // Privileges change: existing sessions must log in again.
    await this.sessions.revokeAll(userId, 'role changed');
    return this.userDto(userId);
  }

  async lockUser(actor: AuditActor & { id: string }, userId: string, reason: string) {
    if (actor.id === userId)
      throw new AppError('FORBIDDEN', 'Du kannst dein eigenes Konto nicht sperren.');
    const target = await this.db.user.findUnique({ where: { id: userId } });
    if (!target) throw new AppError('NOT_FOUND', 'Nutzer nicht gefunden.');
    if (target.status === 'LOCKED')
      throw new AppError('CONFLICT', 'Das Konto ist bereits gesperrt.');
    await withTransaction(this.db, async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { status: 'LOCKED', lockedAt: this.now(), lockedReason: reason },
      });
      await recordAudit(tx, actor, {
        action: 'admin.user_locked',
        targetType: 'user',
        targetId: userId,
        metadata: { reason },
      });
    });
    await this.sessions.revokeAll(userId, 'account locked');
    return this.userDto(userId);
  }

  async unlockUser(actor: AuditActor, userId: string, reason: string) {
    const target = await this.db.user.findUnique({ where: { id: userId } });
    if (!target) throw new AppError('NOT_FOUND', 'Nutzer nicht gefunden.');
    if (target.status !== 'LOCKED') throw new AppError('CONFLICT', 'Das Konto ist nicht gesperrt.');
    await withTransaction(this.db, async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { status: 'ACTIVE', lockedAt: null, lockedReason: null },
      });
      await recordAudit(tx, actor, {
        action: 'admin.user_unlocked',
        targetType: 'user',
        targetId: userId,
        metadata: { reason, previousReason: target.lockedReason },
      });
    });
    return this.userDto(userId);
  }

  async revokeSessions(actor: AuditActor, userId: string) {
    const count = await this.sessions.revokeAll(userId, 'revoked by staff');
    await recordAudit(this.db, actor, {
      action: 'admin.user_sessions_revoked',
      targetType: 'user',
      targetId: userId,
      metadata: { count },
    });
    return { revoked: count };
  }

  // ─── events ───────────────────────────────────────────────────────────────

  async listEvents(
    query: z.infer<typeof adminEventListQuery>,
  ): Promise<Paginated<AdminEventListItemDto>> {
    const now = this.now();
    const where: Prisma.EventWhereInput = {};
    if (query.sport) where.sport = { key: query.sport };
    if (query.status) where.status = query.status;
    if (query.provider) where.provider = query.provider;
    if (query.awaitingSettlement === 'true') {
      where.settledAt = null;
      where.status = { in: ['FINISHED', 'CANCELLED'] };
    }
    if (query.q) {
      where.OR = [
        { homeTeam: { name: { contains: query.q, mode: 'insensitive' } } },
        { awayTeam: { name: { contains: query.q, mode: 'insensitive' } } },
        { league: { name: { contains: query.q, mode: 'insensitive' } } },
        ...(/^[0-9a-f-]{36}$/i.test(query.q) ? [{ id: query.q }] : []),
      ];
    }
    const rows = await this.db.event.findMany({
      where,
      include: {
        sport: { select: { key: true, name: true } },
        league: { select: { id: true, name: true, country: true } },
        homeTeam: { select: { id: true, name: true, shortName: true } },
        awayTeam: { select: { id: true, name: true, shortName: true } },
        markets: {
          where: { type: { in: ['MATCH_RESULT', 'MATCH_WINNER'] } },
          include: { selections: true },
          take: 1,
        },
        _count: { select: { markets: true } },
      },
      orderBy: [{ startTime: 'desc' }, { id: 'desc' }],
      ...cursorArgs(query.cursor, query.limit),
    });
    return page(rows, query.limit, (e) => ({
      id: e.id,
      sport: { key: e.sport.key as SportKey, name: e.sport.name },
      league: e.league,
      home: e.homeTeam,
      away: e.awayTeam,
      startTime: e.startTime.toISOString(),
      status: effectiveEventStatus(e),
      rawStatus: e.status,
      isLive: e.status === 'LIVE',
      score: e.homeScore == null ? null : { home: e.homeScore, away: e.awayScore ?? 0 },
      liveState: parseLiveState(e.liveState),
      dataSource: { provider: e.provider, isSimulated: isSimulatedProvider(e.provider) },
      mainMarket: e.markets[0] ? toMarketDto(e.markets[0], e, now) : null,
      marketCount: e._count.markets,
      provider: e.provider,
      isActive: e.isActive,
      tradingSuspended: e.tradingSuspended,
      resultConfirmedAt: e.resultConfirmedAt?.toISOString() ?? null,
      settledAt: e.settledAt?.toISOString() ?? null,
    }));
  }

  async getEvent(id: string): Promise<AdminEventDto> {
    const now = this.now();
    const e = await this.db.event.findUnique({
      where: { id },
      include: {
        sport: { select: { key: true, name: true } },
        league: { select: { id: true, name: true, country: true } },
        homeTeam: { select: { id: true, name: true, shortName: true } },
        awayTeam: { select: { id: true, name: true, shortName: true } },
        markets: {
          include: { selections: { orderBy: { sortOrder: 'asc' } } },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    if (!e) throw new AppError('NOT_FOUND', 'Event nicht gefunden.');
    const [betCount, openBetCount] = await Promise.all([
      this.db.bet.count({ where: { selections: { some: { eventId: id } } } }),
      this.db.bet.count({ where: { status: 'PENDING', selections: { some: { eventId: id } } } }),
    ]);
    const markets = e.markets.map((m) => {
      const dto = toMarketDto(m, e, now);
      return {
        ...dto,
        rawStatus: m.status,
        tradingSuspended: m.tradingSuspended,
        settledAt: m.settledAt?.toISOString() ?? null,
        selections: dto.selections.map((s) => {
          const raw = m.selections.find((r) => r.id === s.id)!;
          return {
            ...s,
            rawStatus: raw.status,
            result: raw.result,
            suspensionReason: raw.suspensionReason,
          };
        }),
      };
    });
    return {
      id: e.id,
      sport: { key: e.sport.key as SportKey, name: e.sport.name },
      league: e.league,
      home: e.homeTeam,
      away: e.awayTeam,
      startTime: e.startTime.toISOString(),
      status: effectiveEventStatus(e),
      rawStatus: e.status,
      isLive: e.status === 'LIVE',
      score: e.homeScore == null ? null : { home: e.homeScore, away: e.awayScore ?? 0 },
      liveState: parseLiveState(e.liveState),
      statistics: parseStatistics(e.statistics),
      dataSource: { provider: e.provider, isSimulated: isSimulatedProvider(e.provider) },
      mainMarket:
        markets.find((m) => m.type === 'MATCH_RESULT' || m.type === 'MATCH_WINNER') ?? null,
      marketCount: markets.length,
      provider: e.provider,
      isActive: e.isActive,
      tradingSuspended: e.tradingSuspended,
      resultConfirmedAt: e.resultConfirmedAt?.toISOString() ?? null,
      settledAt: e.settledAt?.toISOString() ?? null,
      betCount,
      openBetCount,
      markets,
    };
  }

  async catalog(): Promise<AdminCatalogDto> {
    const [sports, leagues, teams] = await Promise.all([
      this.db.sport.findMany({ orderBy: { sortOrder: 'asc' } }),
      this.db.league.findMany({
        include: { sport: { select: { key: true } } },
        orderBy: { name: 'asc' },
      }),
      this.db.team.findMany({
        include: {
          sport: { select: { key: true } },
          players: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
        },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      sports: sports.map((s) => ({ key: s.key as SportKey, name: s.name })),
      leagues: leagues.map((l) => ({ id: l.id, name: l.name, sportKey: l.sport.key as SportKey })),
      teams: teams.map((t) => ({
        id: t.id,
        name: t.name,
        sportKey: t.sport.key as SportKey,
        players: t.players,
      })),
    };
  }

  async createEvent(actor: AuditActor, input: AdminCreateEventInput): Promise<AdminEventDto> {
    const sport = await this.db.sport.findUnique({ where: { key: input.sport } });
    if (!sport) throw new AppError('NOT_FOUND', 'Sportart nicht gefunden.');
    const [league, home, away] = await Promise.all([
      this.db.league.findUnique({ where: { id: input.leagueId } }),
      this.db.team.findUnique({ where: { id: input.homeTeamId }, include: { players: true } }),
      this.db.team.findUnique({ where: { id: input.awayTeamId }, include: { players: true } }),
    ]);
    if (!league || league.sportId !== sport.id)
      throw new AppError('VALIDATION_ERROR', 'Die Liga gehört nicht zu dieser Sportart.');
    if (!home || !away || home.sportId !== sport.id || away.sportId !== sport.id) {
      throw new AppError('VALIDATION_ERROR', 'Die Teams gehören nicht zu dieser Sportart.');
    }
    if (input.startTime.getTime() <= this.now().getTime()) {
      throw new AppError('VALIDATION_ERROR', 'Die Startzeit muss in der Zukunft liegen.', {
        details: { fields: { startTime: 'Startzeit liegt in der Vergangenheit' } },
      });
    }
    const players = new Map([...home.players, ...away.players].map((p) => [p.id, p.name]));
    const seenKeys = new Set<string>();
    const markets = input.markets.map((m, index) => {
      const definition = MARKET_DEFINITIONS[m.type];
      if (!definition.sports.includes(input.sport)) {
        throw new AppError(
          'VALIDATION_ERROR',
          `${definition.label} ist für ${sport.name} nicht verfügbar.`,
        );
      }
      if (definition.hasLine !== (m.line !== null)) {
        throw new AppError(
          'VALIDATION_ERROR',
          `${definition.label}: Linie ${definition.hasLine ? 'erforderlich' : 'nicht erlaubt'}.`,
        );
      }
      const key = marketKey(m.type, m.line);
      if (seenKeys.has(key))
        throw new AppError('VALIDATION_ERROR', `Markt ${definition.label} ist doppelt.`);
      seenKeys.add(key);
      const outcomes = new Set<string>();
      const selections = m.selections.map((s, i) => {
        if (!(definition.outcomes as readonly string[]).includes(s.outcome)) {
          throw new AppError(
            'VALIDATION_ERROR',
            `Ungültiges Ergebnis ${s.outcome} für ${definition.label}.`,
          );
        }
        const outcome = s.outcome as Outcome;
        if (outcome === 'PLAYER' && (!s.playerId || !players.has(s.playerId))) {
          throw new AppError(
            'VALIDATION_ERROR',
            'Spielermärkte brauchen einen Spieler eines der beiden Teams.',
          );
        }
        const selKey = outcome === 'PLAYER' ? `PLAYER:${s.playerId}` : outcome;
        if (outcomes.has(selKey))
          throw new AppError('VALIDATION_ERROR', `Doppelte Auswahl in ${definition.label}.`);
        outcomes.add(selKey);
        return {
          key: selKey,
          outcome,
          playerId: outcome === 'PLAYER' ? s.playerId! : null,
          name:
            s.name ||
            selectionName(
              m.type,
              outcome,
              m.line,
              home.name,
              away.name,
              s.playerId ? players.get(s.playerId) : undefined,
            ),
          odds: milliToDecimal(Math.round(s.odds * 1000)),
          sortOrder: i,
        };
      });
      if (definition.outcomes[0] !== 'PLAYER' && selections.length !== definition.outcomes.length) {
        throw new AppError(
          'VALIDATION_ERROR',
          `${definition.label} braucht alle ${definition.outcomes.length} Auswahlen.`,
        );
      }
      return {
        key,
        type: m.type,
        name:
          m.line == null
            ? definition.label
            : `${definition.label} ${definition.kind === 'HANDICAP' && m.line > 0 ? '+' : ''}${m.line}`,
        line: m.line == null ? null : new Prisma.Decimal(m.line),
        sortOrder: definition.sortOrder * 100 + index,
        selections,
      };
    });

    const id = randomUUID();
    await withTransaction(this.db, async (tx) => {
      await tx.event.create({
        data: {
          id,
          sportId: sport.id,
          leagueId: league.id,
          homeTeamId: home.id,
          awayTeamId: away.id,
          provider: 'manual',
          externalId: id,
          startTime: input.startTime,
          status: 'SCHEDULED',
          liveState: { period: 'PRE', clock: null },
        },
      });
      for (const m of markets) {
        await tx.market.create({
          data: {
            eventId: id,
            key: m.key,
            type: m.type,
            name: m.name,
            line: m.line,
            sortOrder: m.sortOrder,
            selections: { create: m.selections },
          },
        });
      }
      await recordAudit(tx, actor, {
        action: 'admin.event_created',
        targetType: 'event',
        targetId: id,
        metadata: {
          name: `${home.name} – ${away.name}`,
          startTime: input.startTime.toISOString(),
          markets: markets.length,
        },
      });
    });
    await this.invalidateCatalog();
    return this.getEvent(id);
  }

  async updateEvent(actor: AuditActor, id: string, input: { startTime?: Date; reason: string }) {
    const event = await this.db.event.findUnique({ where: { id } });
    if (!event) throw new AppError('NOT_FOUND', 'Event nicht gefunden.');
    if (event.provider !== 'manual') {
      throw new AppError(
        'FORBIDDEN',
        'Anstoßzeiten von Feed-Events werden vom Provider gesteuert.',
      );
    }
    if (event.settledAt || event.status === 'FINISHED' || event.status === 'CANCELLED') {
      throw new AppError('CONFLICT', 'Beendete Events können nicht mehr geändert werden.');
    }
    if (input.startTime) {
      await withTransaction(this.db, async (tx) => {
        await tx.event.update({ where: { id }, data: { startTime: input.startTime } });
        await recordAudit(tx, actor, {
          action: 'admin.event_updated',
          targetType: 'event',
          targetId: id,
          metadata: {
            startTime: { from: event.startTime.toISOString(), to: input.startTime!.toISOString() },
            reason: input.reason,
          },
        });
      });
    }
    await this.invalidateCatalog();
    return this.getEvent(id);
  }

  async eventAction(
    actor: AuditActor,
    id: string,
    action: (typeof EVENT_ACTIONS)[number],
    reason: string,
  ) {
    const event = await this.db.event.findUnique({
      where: { id },
      include: { sport: { select: { key: true } } },
    });
    if (!event) throw new AppError('NOT_FOUND', 'Event nicht gefunden.');
    if (event.settledAt) throw new AppError('CONFLICT', 'Das Event ist bereits abgerechnet.');
    const data: Prisma.EventUpdateInput = {};
    switch (action) {
      case 'activate':
        data.isActive = true;
        break;
      case 'deactivate':
        data.isActive = false;
        break;
      case 'suspend':
        data.tradingSuspended = true;
        break;
      case 'resume':
        data.tradingSuspended = false;
        if (event.status === 'POSTPONED') data.status = 'SCHEDULED';
        break;
      case 'start':
        if (event.provider !== 'manual')
          throw new AppError('FORBIDDEN', 'Feed-Events werden vom Provider gestartet.');
        if (event.status !== 'SCHEDULED')
          throw new AppError('CONFLICT', 'Nur geplante Events können gestartet werden.');
        data.status = 'LIVE';
        data.liveState = {
          period:
            event.sport.key === 'tennis' ? 'S1' : event.sport.key === 'basketball' ? 'Q1' : '1H',
          clock: null,
        };
        data.homeScore = 0;
        data.awayScore = 0;
        break;
      case 'cancel':
        if (event.status === 'FINISHED')
          throw new AppError('CONFLICT', 'Beendete Events können nicht abgesagt werden.');
        data.status = 'CANCELLED';
        data.resultConfirmedAt = this.now();
        break;
      case 'postpone':
        if (event.status !== 'SCHEDULED')
          throw new AppError('CONFLICT', 'Nur geplante Events können verschoben werden.');
        data.status = 'POSTPONED';
        break;
    }
    const updated = await withTransaction(this.db, async (tx) => {
      const row = await tx.event.update({ where: { id }, data });
      await recordAudit(tx, actor, {
        action: `admin.event_${action}`,
        targetType: 'event',
        targetId: id,
        metadata: {
          reason,
          before: {
            status: event.status,
            isActive: event.isActive,
            tradingSuspended: event.tradingSuspended,
          },
          after: {
            status: row.status,
            isActive: row.isActive,
            tradingSuspended: row.tradingSuspended,
          },
        },
      });
      return row;
    });
    await this.publishEvent(updated.id);
    await this.invalidateCatalog();
    if (action === 'cancel') await this.settlement.settleEvent(id, actor);
    return this.getEvent(id);
  }

  async setResult(actor: AuditActor, id: string, statistics: EventStatistics, reason: string) {
    const event = await this.db.event.findUnique({
      where: { id },
      include: { sport: { select: { key: true } } },
    });
    if (!event) throw new AppError('NOT_FOUND', 'Event nicht gefunden.');
    if (event.settledAt)
      throw new AppError(
        'CONFLICT',
        'Das Event ist bereits abgerechnet; Ergebnisse sind unveränderlich.',
      );
    if (event.status === 'CANCELLED') throw new AppError('CONFLICT', 'Das Event wurde abgesagt.');
    if (statistics.sport !== event.sport.key) {
      throw new AppError('VALIDATION_ERROR', 'Die Statistik passt nicht zur Sportart des Events.');
    }
    if (event.startTime > this.now()) {
      throw new AppError(
        'CONFLICT',
        'Ein Ergebnis kann erst nach Beginn des Events erfasst werden.',
      );
    }
    const score = scoreFrom(statistics);
    await withTransaction(this.db, async (tx) => {
      await tx.event.update({
        where: { id },
        data: {
          status: 'FINISHED',
          homeScore: score.home,
          awayScore: score.away,
          statistics: statistics as unknown as Prisma.InputJsonValue,
          liveState: { period: 'FT', clock: null },
          resultConfirmedAt: this.now(),
        },
      });
      await recordAudit(tx, actor, {
        action: 'admin.event_result_set',
        targetType: 'event',
        targetId: id,
        metadata: {
          reason,
          score: `${score.home}:${score.away}`,
          previous: {
            status: event.status,
            score: event.homeScore == null ? null : `${event.homeScore}:${event.awayScore}`,
          },
        },
      });
    });
    await this.publishEvent(id);
    await this.invalidateCatalog();
    const report = await this.settlement.settleEvent(id, actor);
    return { event: await this.getEvent(id), settlement: report };
  }

  async settleEvent(actor: AuditActor, id: string) {
    const report = await this.settlement.settleEvent(id, actor);
    await recordAudit(this.db, actor, {
      action: 'admin.event_settlement_triggered',
      targetType: 'event',
      targetId: id,
      metadata: { ...report },
    });
    return report;
  }

  async marketAction(
    actor: AuditActor,
    marketId: string,
    input: z.infer<typeof adminMarketActionSchema>,
  ) {
    const market = await this.db.market.findUnique({
      where: { id: marketId },
      include: { event: true },
    });
    if (!market) throw new AppError('NOT_FOUND', 'Markt nicht gefunden.');
    if (market.status === 'SETTLED')
      throw new AppError('CONFLICT', 'Abgerechnete Märkte sind unveränderlich.');
    const manual = market.event.provider === 'manual';
    const data: Prisma.MarketUpdateInput = {};
    if (input.action === 'suspend') data.tradingSuspended = true;
    if (input.action === 'open') {
      data.tradingSuspended = false;
      if (manual) data.status = 'OPEN';
    }
    if (input.action === 'close') {
      // Feed markets would be reopened by the next sync; the staff lock is what sticks.
      if (manual) data.status = 'CLOSED';
      else data.tradingSuspended = true;
    }
    const updated = await withTransaction(this.db, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "markets" WHERE "id" = ${marketId}::uuid FOR UPDATE`;
      const row = await tx.market.update({ where: { id: marketId }, data });
      await recordAudit(tx, actor, {
        action: `admin.market_${input.action}`,
        targetType: 'market',
        targetId: marketId,
        metadata: {
          reason: input.reason,
          eventId: market.eventId,
          before: { status: market.status, tradingSuspended: market.tradingSuspended },
          after: { status: row.status, tradingSuspended: row.tradingSuspended },
        },
      });
      return row;
    });
    await publishRealtime(this.redis, [
      {
        type: 'market',
        eventId: market.eventId,
        markets: [
          { id: marketId, status: updated.tradingSuspended ? 'SUSPENDED' : updated.status },
        ],
      },
    ]).catch(() => undefined);
    await this.invalidateCatalog();
    return this.getEvent(market.eventId);
  }

  async updateSelection(
    actor: AuditActor,
    selectionId: string,
    input: z.infer<typeof adminSelectionUpdateSchema>,
  ) {
    const selection = await this.db.selection.findUnique({
      where: { id: selectionId },
      include: { market: { include: { event: true } } },
    });
    if (!selection) throw new AppError('NOT_FOUND', 'Auswahl nicht gefunden.');
    if (selection.market.event.provider !== 'manual') {
      throw new AppError(
        'FORBIDDEN',
        'Quoten von Feed-Events werden vom Provider gesteuert. Sperre den Markt stattdessen.',
      );
    }
    if (selection.market.status === 'SETTLED' || selection.result !== 'PENDING') {
      throw new AppError('CONFLICT', 'Abgerechnete Auswahlen sind unveränderlich.');
    }
    const updated = await withTransaction(this.db, async (tx) => {
      // Same lock order as placement: the market row, then the selection row.
      await tx.$queryRaw`SELECT "id" FROM "markets" WHERE "id" = ${selection.marketId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "selections" WHERE "id" = ${selectionId}::uuid FOR UPDATE`;
      const row = await tx.selection.update({
        where: { id: selectionId },
        data: {
          ...(input.odds !== undefined
            ? { odds: milliToDecimal(Math.round(input.odds * 1000)), oddsUpdatedAt: this.now() }
            : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          oddsVersion: { increment: 1 },
        },
      });
      await recordAudit(tx, actor, {
        action: 'admin.selection_updated',
        targetType: 'selection',
        targetId: selectionId,
        metadata: {
          reason: input.reason,
          eventId: selection.market.eventId,
          before: { odds: oddsToMilli(selection.odds) / 1000, status: selection.status },
          after: { odds: oddsToMilli(row.odds) / 1000, status: row.status },
        },
      });
      return row;
    });
    await publishRealtime(this.redis, [
      {
        type: 'odds',
        eventId: selection.market.eventId,
        selections: [
          {
            id: updated.id,
            marketId: updated.marketId,
            odds: oddsToMilli(updated.odds) / 1000,
            status: updated.status,
            oddsVersion: updated.oddsVersion,
          },
        ],
      },
    ]).catch(() => undefined);
    await this.invalidateCatalog();
    return this.getEvent(selection.market.eventId);
  }

  // ─── bets, ledger, audit ──────────────────────────────────────────────────

  async listBets(query: z.infer<typeof adminBetListQuery>): Promise<Paginated<AdminBetDto>> {
    const where: Prisma.BetWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.userId) where.userId = query.userId;
    if (query.eventId) where.selections = { some: { eventId: query.eventId } };
    if (query.q) {
      where.OR = [
        { reference: { contains: query.q.toUpperCase() } },
        { user: { email: { contains: query.q.toLowerCase() } } },
      ];
    }
    const rows = await this.db.bet.findMany({
      where,
      include: { ...BET_INCLUDE, user: { select: { id: true, email: true, displayName: true } } },
      orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(query.cursor, query.limit),
    });
    return page(rows, query.limit, (bet) => ({ ...toBetDto(bet), user: userRef(bet.user) }));
  }

  async getBet(id: string): Promise<AdminBetDetailDto> {
    const bet = await this.db.bet.findUnique({
      where: { id },
      include: {
        ...BET_INCLUDE,
        user: { select: { id: true, email: true, displayName: true } },
        transactions: { include: TRANSACTION_INCLUDE, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!bet) throw new AppError('NOT_FOUND', 'Wette nicht gefunden.');
    const audit = await this.db.auditLog.findMany({
      where: { targetType: 'bet', targetId: id },
      include: { actor: { select: { email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      ...toBetDto(bet),
      user: userRef(bet.user),
      transactions: bet.transactions.map(toTransactionDto),
      audit: audit.map(toAuditDto),
    };
  }

  async refundBet(actor: AuditActor, id: string, reason: string) {
    await this.settlement.refundBet(id, actor, reason);
    return this.getBet(id);
  }

  async settleBet(actor: AuditActor, id: string) {
    const status = await this.settlement.settleBet(id, actor);
    if (!status)
      throw new AppError('CONFLICT', 'Die Wette ist nicht offen oder noch nicht entscheidbar.');
    return this.getBet(id);
  }

  async listTransactions(
    query: z.infer<typeof adminTransactionListQuery>,
  ): Promise<Paginated<AdminTransactionDto>> {
    const where: Prisma.TransactionWhereInput = {};
    if (query.userId) where.userId = query.userId;
    if (query.betId) where.betId = query.betId;
    if (query.type) where.type = query.type;
    const rows = await this.db.transaction.findMany({
      where,
      include: {
        ...TRANSACTION_INCLUDE,
        user: { select: { id: true, email: true, displayName: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(query.cursor, query.limit),
    });
    return page(rows, query.limit, (tx) => ({ ...toTransactionDto(tx), user: userRef(tx.user) }));
  }

  async listAudit(query: z.infer<typeof adminAuditListQuery>): Promise<Paginated<AuditLogDto>> {
    const where: Prisma.AuditLogWhereInput = {};
    if (query.action) where.action = { contains: query.action };
    if (query.actorId) where.actorId = query.actorId;
    if (query.targetType) where.targetType = query.targetType;
    if (query.targetId) where.targetId = query.targetId;
    const rows = await this.db.auditLog.findMany({
      where,
      include: { actor: { select: { email: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(query.cursor, query.limit),
    });
    return page(rows, query.limit, toAuditDto);
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private async publishEvent(id: string): Promise<void> {
    const e = await this.db.event.findUnique({
      where: { id },
      include: { sport: { select: { key: true } } },
    });
    if (!e) return;
    await publishRealtime(this.redis, [
      {
        type: 'event',
        eventId: e.id,
        sportKey: e.sport.key,
        status: effectiveEventStatus(e),
        isActive: e.isActive,
        score: e.homeScore == null ? null : { home: e.homeScore, away: e.awayScore ?? 0 },
        liveState: parseLiveState(e.liveState),
        statistics: parseStatistics(e.statistics),
      },
    ]).catch(() => undefined);
  }

  private async invalidateCatalog(): Promise<void> {
    await this.cache.delPrefix('catalog:').catch(() => undefined);
  }
}
