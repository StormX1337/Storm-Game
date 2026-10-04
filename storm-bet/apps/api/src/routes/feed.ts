import { BET_INCLUDE, toBetDto } from '@storm-bet/betting-engine';
import type { Prisma } from '@storm-bet/database';
import { AppError, type FeedItemDto } from '@storm-bet/types';
import { feedQuery, idParam } from '@storm-bet/validation';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { cursorArgs, page } from '../lib/pagination';
import { parse } from '../lib/validate';
import { authenticated, requireSession } from '../plugins/auth';

/** Nobody needs to follow more players than this; keeps the feed query cheap. */
const MAX_FOLLOWS = 500;

const feedInclude = (viewerId: string) =>
  ({
    user: { select: { displayName: true } },
    bet: { include: BET_INCLUDE },
    likes: { where: { userId: viewerId }, select: { userId: true } },
    _count: { select: { likes: true } },
  }) satisfies Prisma.SharedBetInclude;
type FeedRow = Prisma.SharedBetGetPayload<{ include: ReturnType<typeof feedInclude> }>;

/** Picks, odds and result only: stakes, payouts and cashouts stay private. */
function toFeedItem(row: FeedRow, viewerId: string, followed: Set<string>): FeedItemDto {
  const bet = toBetDto(row.bet);
  return {
    id: row.id,
    sharedAt: row.createdAt.toISOString(),
    author: row.user.displayName,
    authorId: row.userId,
    own: row.userId === viewerId,
    following: followed.has(row.userId),
    likes: row._count.likes,
    liked: row.likes.length > 0,
    bet: {
      id: bet.id,
      type: bet.type,
      status: bet.status,
      totalOdds: bet.totalOdds,
      system: bet.system,
      boosted: bet.boosted,
      placedAt: bet.placedAt,
      selections: bet.selections.map(({ snapshot: _snapshot, ...leg }) => leg),
    },
  };
}

/** Tip feed: players show their own bets; others can take the picks over. */
export function feedRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', authenticated);

    app.get('/feed', async (request) => {
      const session = requireSession(request);
      const query = parse(feedQuery, request.query);
      const where: Prisma.SharedBetWhereInput =
        query.filter === 'open'
          ? { bet: { status: 'PENDING' } }
          : query.filter === 'won'
            ? { bet: { status: 'WON' } }
            : query.filter === 'following'
              ? { user: { followers: { some: { followerId: session.userId } } } }
              : {};
      const rows = await ctx.db.sharedBet.findMany({
        where,
        include: feedInclude(session.userId),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...cursorArgs(query.cursor, query.limit),
      });
      const follows = await ctx.db.follow.findMany({
        where: {
          followerId: session.userId,
          followeeId: { in: [...new Set(rows.map((r) => r.userId))] },
        },
        select: { followeeId: true },
      });
      const followed = new Set(follows.map((f) => f.followeeId));
      return page(rows, query.limit, (row) => toFeedItem(row, session.userId, followed));
    });

    app.post('/bets/:id/share', async (request) => {
      const session = requireSession(request);
      const { id } = parse(idParam, request.params);
      const bet = await ctx.db.bet.findFirst({ where: { id, userId: session.userId } });
      if (!bet) throw new AppError('NOT_FOUND', 'Wette nicht gefunden.');
      await ctx.db.sharedBet.upsert({
        where: { betId: id },
        create: { betId: id, userId: session.userId },
        update: {},
      });
      return { shared: true };
    });

    app.delete('/bets/:id/share', async (request) => {
      const session = requireSession(request);
      const { id } = parse(idParam, request.params);
      await ctx.db.sharedBet.deleteMany({ where: { betId: id, userId: session.userId } });
      return { shared: false };
    });

    const likeCount = (sharedBetId: string) => ctx.db.feedLike.count({ where: { sharedBetId } });

    app.post('/feed/:id/like', async (request) => {
      const session = requireSession(request);
      const { id } = parse(idParam, request.params);
      const tip = await ctx.db.sharedBet.findUnique({ where: { id }, select: { userId: true } });
      if (!tip) throw new AppError('NOT_FOUND', 'Tipp nicht gefunden.');
      if (tip.userId === session.userId)
        throw new AppError('VALIDATION_ERROR', 'Eigene Tipps kannst du nicht liken.');
      await ctx.db.feedLike.createMany({
        data: [{ sharedBetId: id, userId: session.userId }],
        skipDuplicates: true,
      });
      return { liked: true, likes: await likeCount(id) };
    });

    app.delete('/feed/:id/like', async (request) => {
      const session = requireSession(request);
      const { id } = parse(idParam, request.params);
      await ctx.db.feedLike.deleteMany({ where: { sharedBetId: id, userId: session.userId } });
      return { liked: false, likes: await likeCount(id) };
    });

    app.post('/users/:id/follow', async (request) => {
      const session = requireSession(request);
      const { id } = parse(idParam, request.params);
      if (id === session.userId)
        throw new AppError('VALIDATION_ERROR', 'Du kannst dir nicht selbst folgen.');
      const target = await ctx.db.user.findFirst({
        where: { id, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!target) throw new AppError('NOT_FOUND', 'Spieler nicht gefunden.');
      const count = await ctx.db.follow.count({ where: { followerId: session.userId } });
      if (count >= MAX_FOLLOWS)
        throw new AppError('CONFLICT', `Du kannst höchstens ${MAX_FOLLOWS} Spielern folgen.`);
      await ctx.db.follow.createMany({
        data: [{ followerId: session.userId, followeeId: id }],
        skipDuplicates: true,
      });
      return { following: true };
    });

    app.delete('/users/:id/follow', async (request) => {
      const session = requireSession(request);
      const { id } = parse(idParam, request.params);
      await ctx.db.follow.deleteMany({ where: { followerId: session.userId, followeeId: id } });
      return { following: false };
    });
  };
}
