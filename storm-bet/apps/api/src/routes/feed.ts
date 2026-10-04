import { BET_INCLUDE, toBetDto } from '@storm-bet/betting-engine';
import type { Prisma } from '@storm-bet/database';
import { AppError, type FeedItemDto } from '@storm-bet/types';
import { feedQuery, idParam } from '@storm-bet/validation';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { cursorArgs, page } from '../lib/pagination';
import { parse } from '../lib/validate';
import { authenticated, requireSession } from '../plugins/auth';

const FEED_INCLUDE = {
  user: { select: { displayName: true } },
  bet: { include: BET_INCLUDE },
} satisfies Prisma.SharedBetInclude;
type FeedRow = Prisma.SharedBetGetPayload<{ include: typeof FEED_INCLUDE }>;

/** Picks, odds and result only: stakes, payouts and cashouts stay private. */
function toFeedItem(row: FeedRow, viewerId: string): FeedItemDto {
  const bet = toBetDto(row.bet);
  return {
    id: row.id,
    sharedAt: row.createdAt.toISOString(),
    author: row.user.displayName,
    own: row.userId === viewerId,
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
            : {};
      const rows = await ctx.db.sharedBet.findMany({
        where,
        include: FEED_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...cursorArgs(query.cursor, query.limit),
      });
      return page(rows, query.limit, (row) => toFeedItem(row, session.userId));
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
  };
}
