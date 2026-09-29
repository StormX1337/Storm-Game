import { BET_INCLUDE, toBetDto } from '@storm-bet/betting-engine';
import type { Prisma } from '@storm-bet/database';
import { AppError, type BetStatus } from '@storm-bet/types';
import { betListQuery, idParam, placeBetSchema, validateSlipSchema } from '@storm-bet/validation';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { cursorArgs, page } from '../lib/pagination';
import { parse } from '../lib/validate';
import { authenticated, requireSession } from '../plugins/auth';
import { enforceRateLimit, RATE_LIMITS } from '../plugins/rate-limit';

const FILTERS: Record<string, BetStatus[] | undefined> = {
  all: undefined,
  open: ['PENDING'],
  won: ['WON'],
  lost: ['LOST'],
  void: ['VOID', 'REFUNDED'],
  settled: ['WON', 'LOST', 'VOID', 'REFUNDED'],
};

export function betRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.post('/bets/validate', async (request, reply) => {
      await enforceRateLimit(ctx.redis, RATE_LIMITS.validateSlip, request.ip, reply);
      const input = parse(validateSlipSchema, request.body);
      return ctx.placement.validate(request.session?.userId ?? null, input);
    });

    app.post('/bets/place', { preHandler: authenticated }, async (request, reply) => {
      const session = requireSession(request);
      await enforceRateLimit(ctx.redis, RATE_LIMITS.placeBet, session.userId, reply);
      const input = parse(placeBetSchema, request.body);
      const result = await ctx.placement.place(session.userId, input, {
        ip: ctx.env.AUDIT_LOG_IP ? request.ip : null,
        userAgent: request.headers['user-agent'] ?? null,
      });
      reply.status(result.replayed ? 200 : 201);
      return result;
    });

    app.get('/bets', { preHandler: authenticated }, async (request) => {
      const session = requireSession(request);
      const query = parse(betListQuery, request.query);
      const statuses = FILTERS[query.status];
      const where: Prisma.BetWhereInput = {
        userId: session.userId,
        ...(statuses ? { status: { in: statuses } } : {}),
      };
      const rows = await ctx.db.bet.findMany({
        where,
        include: BET_INCLUDE,
        orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
        ...cursorArgs(query.cursor, query.limit),
      });
      return page(rows, query.limit, toBetDto);
    });

    app.get('/bets/:id', { preHandler: authenticated }, async (request) => {
      const session = requireSession(request);
      const { id } = parse(idParam, request.params);
      // Scoped to the owner: another user's bet id is simply "not found".
      const bet = await ctx.db.bet.findFirst({
        where: { id, userId: session.userId },
        include: BET_INCLUDE,
      });
      if (!bet) throw new AppError('NOT_FOUND', 'Wette nicht gefunden.');
      return toBetDto(bet);
    });
  };
}
