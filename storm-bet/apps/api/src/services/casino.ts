import { toRoundDto } from '@storm-bet/casino';
import {
  moneyToNumber,
  recordAudit,
  withTransaction,
  type AuditActor,
  type Prisma,
  type PrismaClient,
} from '@storm-bet/database';
import type { JsonCache } from '@storm-bet/redis';
import {
  AppError,
  type AdminCasinoGameDto,
  type AdminCasinoRoundDto,
  type AdminCasinoSessionDto,
  type CasinoCategoryDto,
  type CasinoGameDto,
  type CasinoLobbyDto,
  type CasinoRoundDto,
  type CasinoRoundStatus,
  type CasinoSessionStatus,
  type CasinoTheme,
  type Paginated,
} from '@storm-bet/types';
import { cursorArgs, page } from '../lib/pagination';

type GameRow = Prisma.CasinoGameGetPayload<{ include: { provider: true } }>;

function toGameDto(g: GameRow, favorites: Set<string>): CasinoGameDto {
  return {
    id: g.id,
    slug: g.slug,
    name: g.name,
    type: g.type,
    categories: g.categories,
    description: g.description,
    provider: { key: g.provider.key, name: g.provider.name, isSimulated: g.provider.isSimulated },
    status: g.status,
    isFeatured: g.isFeatured,
    isNew: g.isNew,
    minStake: moneyToNumber(g.minStake),
    maxStake: moneyToNumber(g.maxStake),
    rtp: Number(g.rtp),
    theme: g.theme as unknown as CasinoTheme,
    isFavorite: favorites.has(g.id),
  };
}

const WEEK_MS = 7 * 24 * 3_600_000;

/** Lobby, favourites, history and staff management of the casino catalogue. */
export class CasinoCatalogService {
  constructor(
    private readonly db: PrismaClient,
    private readonly cache: JsonCache,
    private readonly now: () => Date,
  ) {}

  /** Games players may see: active or in maintenance, from an active provider. */
  private visible(): Prisma.CasinoGameWhereInput {
    return { status: { in: ['ACTIVE', 'MAINTENANCE'] }, provider: { isActive: true } };
  }

  private async favorites(userId: string): Promise<Set<string>> {
    const rows = await this.db.casinoFavorite.findMany({
      where: { userId },
      select: { gameId: true },
    });
    return new Set(rows.map((r) => r.gameId));
  }

  /** Most played games of the last seven days, cached for a minute. */
  private popularIds(): Promise<string[]> {
    return this.cache.wrap('casino:popular', 60, async () => {
      const rows = await this.db.casinoRound.groupBy({
        by: ['gameId'],
        where: { createdAt: { gt: new Date(this.now().getTime() - WEEK_MS) } },
        _count: { _all: true },
        orderBy: { _count: { gameId: 'desc' } },
        take: 12,
      });
      return rows.map((r) => r.gameId);
    });
  }

  async categories(): Promise<CasinoCategoryDto[]> {
    const [categories, games] = await Promise.all([
      this.db.casinoCategory.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
      this.db.casinoGame.findMany({ where: this.visible(), select: { categories: true } }),
    ]);
    return categories.map((c) => ({
      key: c.key,
      name: c.name,
      gameCount: games.filter((g) => g.categories.includes(c.key)).length,
    }));
  }

  async lobby(
    userId: string,
    query: { category?: string; search?: string },
  ): Promise<CasinoLobbyDto> {
    const where: Prisma.CasinoGameWhereInput = {
      ...this.visible(),
      ...(query.category ? { categories: { has: query.category } } : {}),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
    };
    const [rows, favorites, categories, popular] = await Promise.all([
      this.db.casinoGame.findMany({
        where,
        include: { provider: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.favorites(userId),
      this.categories(),
      this.popularIds(),
    ]);
    return { categories, games: rows.map((g) => toGameDto(g, favorites)), popular };
  }

  async game(userId: string, gameId: string): Promise<CasinoGameDto> {
    const game = await this.db.casinoGame.findFirst({
      where: { id: gameId, ...this.visible() },
      include: { provider: true },
    });
    if (!game) throw new AppError('NOT_FOUND', 'Spiel nicht gefunden.');
    return toGameDto(game, await this.favorites(userId));
  }

  async listFavorites(userId: string): Promise<CasinoGameDto[]> {
    const rows = await this.db.casinoFavorite.findMany({
      where: { userId, game: this.visible() },
      include: { game: { include: { provider: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const ids = new Set(rows.map((r) => r.gameId));
    return rows.map((r) => toGameDto(r.game, ids));
  }

  async setFavorite(userId: string, gameId: string, favorite: boolean): Promise<void> {
    if (!favorite) {
      await this.db.casinoFavorite.deleteMany({ where: { userId, gameId } });
      return;
    }
    const game = await this.db.casinoGame.findFirst({ where: { id: gameId, ...this.visible() } });
    if (!game) throw new AppError('NOT_FOUND', 'Spiel nicht gefunden.');
    await this.db.casinoFavorite.upsert({
      where: { userId_gameId: { userId, gameId } },
      create: { userId, gameId },
      update: {},
    });
  }

  async history(
    userId: string,
    query: { cursor?: string; limit: number; gameId?: string; status?: CasinoRoundStatus },
  ): Promise<Paginated<CasinoRoundDto>> {
    const rows = await this.db.casinoRound.findMany({
      where: {
        userId,
        ...(query.gameId ? { gameId: query.gameId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      include: { game: { select: { name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(query.cursor, query.limit),
    });
    return page(rows, query.limit, toRoundDto);
  }

  // ─── staff ────────────────────────────────────────────────────────────────

  async adminGames(): Promise<AdminCasinoGameDto[]> {
    const [rows, counts] = await Promise.all([
      this.db.casinoGame.findMany({
        include: { provider: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.db.casinoRound.groupBy({
        by: ['gameId'],
        where: { createdAt: { gt: new Date(this.now().getTime() - WEEK_MS) } },
        _count: { _all: true },
      }),
    ]);
    const byGame = new Map(counts.map((c) => [c.gameId, c._count._all]));
    return rows.map((g) => {
      const { isFavorite: _f, ...dto } = toGameDto(g, new Set());
      return { ...dto, sortOrder: g.sortOrder, roundsLast7d: byGame.get(g.id) ?? 0 };
    });
  }

  async updateGame(
    gameId: string,
    input: {
      status?: 'ACTIVE' | 'MAINTENANCE' | 'DISABLED';
      isFeatured?: boolean;
      isNew?: boolean;
      sortOrder?: number;
      categories?: string[];
      minStake?: number;
      maxStake?: number;
      reason: string;
    },
    actor: AuditActor,
  ): Promise<void> {
    const { reason, ...changes } = input;
    await withTransaction(this.db, async (tx) => {
      const game = await tx.casinoGame.findUnique({ where: { id: gameId } });
      if (!game) throw new AppError('NOT_FOUND', 'Spiel nicht gefunden.');
      const min = changes.minStake !== undefined ? BigInt(changes.minStake) : game.minStake;
      const max = changes.maxStake !== undefined ? BigInt(changes.maxStake) : game.maxStake;
      if (max < min)
        throw new AppError('VALIDATION_ERROR', 'Höchsteinsatz liegt unter dem Mindesteinsatz.');
      if (changes.categories) {
        const known = await tx.casinoCategory.count({ where: { key: { in: changes.categories } } });
        if (known !== new Set(changes.categories).size)
          throw new AppError('VALIDATION_ERROR', 'Unbekannte Kategorie.');
      }
      await tx.casinoGame.update({
        where: { id: gameId },
        data: {
          ...changes,
          ...(changes.minStake !== undefined ? { minStake: min } : {}),
          ...(changes.maxStake !== undefined ? { maxStake: max } : {}),
        },
      });
      await recordAudit(tx, actor, {
        action: 'casino.game.updated',
        targetType: 'casino_game',
        targetId: gameId,
        metadata: {
          reason,
          changes,
          before: {
            status: game.status,
            isFeatured: game.isFeatured,
            isNew: game.isNew,
            sortOrder: game.sortOrder,
            categories: game.categories,
            minStake: game.minStake.toString(),
            maxStake: game.maxStake.toString(),
          },
        },
      });
    });
    await this.cache.del('casino:popular').catch(() => undefined);
  }

  async adminCategories() {
    return this.db.casinoCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  async updateCategory(
    key: string,
    input: { name?: string; sortOrder?: number; isActive?: boolean; reason: string },
    actor: AuditActor,
  ): Promise<void> {
    const { reason, ...changes } = input;
    await withTransaction(this.db, async (tx) => {
      const before = await tx.casinoCategory.findUnique({ where: { key } });
      if (!before) throw new AppError('NOT_FOUND', 'Kategorie nicht gefunden.');
      await tx.casinoCategory.update({ where: { key }, data: changes });
      await recordAudit(tx, actor, {
        action: 'casino.category.updated',
        targetType: 'casino_category',
        targetId: key,
        metadata: {
          reason,
          changes,
          before: { name: before.name, sortOrder: before.sortOrder, isActive: before.isActive },
        },
      });
    });
  }

  async adminProviders() {
    const rows = await this.db.casinoProvider.findMany({
      include: { _count: { select: { games: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((p) => ({
      key: p.key,
      name: p.name,
      isSimulated: p.isSimulated,
      isActive: p.isActive,
      games: p._count.games,
    }));
  }

  async updateProvider(
    key: string,
    input: { isActive: boolean; reason: string },
    actor: AuditActor,
  ) {
    await withTransaction(this.db, async (tx) => {
      const before = await tx.casinoProvider.findUnique({ where: { key } });
      if (!before) throw new AppError('NOT_FOUND', 'Anbieter nicht gefunden.');
      await tx.casinoProvider.update({ where: { key }, data: { isActive: input.isActive } });
      await recordAudit(tx, actor, {
        action: input.isActive ? 'casino.provider.enabled' : 'casino.provider.disabled',
        targetType: 'casino_provider',
        targetId: key,
        metadata: { reason: input.reason },
      });
    });
  }

  async adminSessions(query: {
    cursor?: string;
    limit: number;
    status?: CasinoSessionStatus;
    userId?: string;
  }): Promise<Paginated<AdminCasinoSessionDto>> {
    const rows = await this.db.casinoSession.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.userId ? { userId: query.userId } : {}),
      },
      include: {
        user: { select: { id: true, email: true } },
        game: { select: { id: true, name: true } },
        _count: { select: { rounds: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(query.cursor, query.limit),
    });
    return page(rows, query.limit, (s) => ({
      id: s.id,
      user: s.user,
      game: s.game,
      status: s.status,
      createdAt: s.createdAt.toISOString(),
      lastActivityAt: s.lastActivityAt.toISOString(),
      closedAt: s.closedAt?.toISOString() ?? null,
      closedReason: s.closedReason,
      rounds: s._count.rounds,
    }));
  }

  async adminRounds(query: {
    cursor?: string;
    limit: number;
    status?: CasinoRoundStatus;
    userId?: string;
    gameId?: string;
  }): Promise<Paginated<AdminCasinoRoundDto>> {
    const rows = await this.db.casinoRound.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.gameId ? { gameId: query.gameId } : {}),
      },
      include: { game: { select: { name: true } }, user: { select: { id: true, email: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(query.cursor, query.limit),
    });
    return page(rows, query.limit, (r) => ({
      ...toRoundDto(r),
      user: r.user,
      sessionId: r.sessionId,
    }));
  }
}
