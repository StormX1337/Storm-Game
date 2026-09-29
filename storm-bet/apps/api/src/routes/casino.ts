import {
  casinoGameParam,
  casinoGamesQuery,
  casinoHistoryQuery,
  casinoPlaySchema,
  idParam,
} from '@storm-bet/validation';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { parse } from '../lib/validate';
import { authenticated, requireSession } from '../plugins/auth';
import { enforceRateLimit, RATE_LIMITS } from '../plugins/rate-limit';
import type { CasinoCatalogService } from '../services/casino';

/**
 * Player casino API (play money only). Every route needs a session, is
 * validated and rate limited per user; rounds are decided on the server.
 */
export function casinoRoutes(ctx: AppContext, catalog: CasinoCatalogService) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', authenticated);
    app.addHook('preHandler', async (request, reply) => {
      const session = requireSession(request);
      await enforceRateLimit(ctx.redis, RATE_LIMITS.casino, session.userId, reply);
    });

    app.get('/categories', async () => catalog.categories());

    app.get('/games', async (request) =>
      catalog.lobby(requireSession(request).userId, parse(casinoGamesQuery, request.query)),
    );

    app.get('/games/:gameId', async (request) => {
      const { gameId } = parse(casinoGameParam, request.params);
      return catalog.game(requireSession(request).userId, gameId);
    });

    app.post('/games/:gameId/session', async (request, reply) => {
      const session = requireSession(request);
      await enforceRateLimit(ctx.redis, RATE_LIMITS.casinoSession, session.userId, reply);
      const { gameId } = parse(casinoGameParam, request.params);
      reply.status(201);
      return ctx.casino.openSession(session.userId, gameId);
    });

    app.post('/sessions/:id/close', async (request, reply) => {
      const session = requireSession(request);
      const { id } = parse(idParam, request.params);
      await ctx.casino.closeSession(id, { userId: session.userId }, 'Vom Spieler beendet');
      reply.status(204);
    });

    app.post('/games/:gameId/play', async (request, reply) => {
      const session = requireSession(request);
      await enforceRateLimit(ctx.redis, RATE_LIMITS.casinoPlay, session.userId, reply);
      const { gameId } = parse(casinoGameParam, request.params);
      const result = await ctx.casino.play(
        session.userId,
        gameId,
        parse(casinoPlaySchema, request.body),
      );
      reply.status(result.replayed ? 200 : 201);
      return result;
    });

    app.get('/favorites', async (request) => catalog.listFavorites(requireSession(request).userId));

    app.post('/favorites/:gameId', async (request, reply) => {
      const { gameId } = parse(casinoGameParam, request.params);
      await catalog.setFavorite(requireSession(request).userId, gameId, true);
      reply.status(204);
    });

    app.delete('/favorites/:gameId', async (request, reply) => {
      const { gameId } = parse(casinoGameParam, request.params);
      await catalog.setFavorite(requireSession(request).userId, gameId, false);
      reply.status(204);
    });

    app.get('/history', async (request) =>
      catalog.history(requireSession(request).userId, parse(casinoHistoryQuery, request.query)),
    );
  };
}
