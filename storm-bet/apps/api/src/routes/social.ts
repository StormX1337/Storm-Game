import { recordAudit } from '@storm-bet/database';
import { AppError, type SavedSlipDto } from '@storm-bet/types';
import {
  idParam,
  leaderboardOptInSchema,
  leaderboardQuery,
  savedSlipSchema,
} from '@storm-bet/validation';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { parse } from '../lib/validate';
import { authenticated, requireSession } from '../plugins/auth';
import type { LeaderboardService } from '../services/leaderboard';
import { actorOf } from './request-info';

const MAX_SAVED_SLIPS = 20;

const toSavedSlip = (row: {
  id: string;
  name: string;
  selectionIds: string[];
  createdAt: Date;
}): SavedSlipDto => ({
  id: row.id,
  name: row.name,
  selectionIds: row.selectionIds,
  createdAt: row.createdAt.toISOString(),
});

/** Saved bet slips and the leaderboard. */
export function socialRoutes(ctx: AppContext, leaderboard: LeaderboardService) {
  return async (app: FastifyInstance) => {
    // Public: guests see the ranking, players also their own numbers.
    app.get('/leaderboard', async (request) => {
      const query = parse(leaderboardQuery, request.query);
      return leaderboard.board(query.period, query.by, request.session?.userId ?? null);
    });

    app.put('/account/leaderboard', { preHandler: authenticated }, async (request) => {
      const { optIn } = parse(leaderboardOptInSchema, request.body);
      const actor = actorOf(request, ctx.env.AUDIT_LOG_IP);
      await leaderboard.setOptIn(actor.id, optIn);
      await recordAudit(ctx.db, actor, {
        action: optIn ? 'user.leaderboard_joined' : 'user.leaderboard_left',
        targetType: 'user',
        targetId: actor.id,
      });
      return { optIn };
    });

    app.get('/slips/saved', { preHandler: authenticated }, async (request) => {
      const session = requireSession(request);
      const rows = await ctx.db.savedSlip.findMany({
        where: { userId: session.userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_SAVED_SLIPS,
      });
      return { slips: rows.map(toSavedSlip) };
    });

    app.post('/slips/saved', { preHandler: authenticated }, async (request, reply) => {
      const session = requireSession(request);
      const input = parse(savedSlipSchema, request.body);
      const count = await ctx.db.savedSlip.count({ where: { userId: session.userId } });
      if (count >= MAX_SAVED_SLIPS)
        throw new AppError(
          'CONFLICT',
          `Du kannst höchstens ${MAX_SAVED_SLIPS} Wettscheine speichern. Lösche zuerst einen alten.`,
        );
      const row = await ctx.db.savedSlip.create({
        data: { userId: session.userId, name: input.name, selectionIds: input.selectionIds },
      });
      reply.status(201);
      return toSavedSlip(row);
    });

    app.delete('/slips/saved/:id', { preHandler: authenticated }, async (request) => {
      const session = requireSession(request);
      const { id } = parse(idParam, request.params);
      const { count } = await ctx.db.savedSlip.deleteMany({
        where: { id, userId: session.userId },
      });
      if (count === 0) throw new AppError('NOT_FOUND', 'Wettschein nicht gefunden.');
      return { deleted: true };
    });
  };
}
