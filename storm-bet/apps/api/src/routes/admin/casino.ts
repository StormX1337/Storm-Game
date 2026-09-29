import { Permission } from '@storm-bet/types';
import {
  adminCasinoCategoryUpdateSchema,
  adminCasinoGameUpdateSchema,
  adminCasinoProviderUpdateSchema,
  adminCasinoReasonSchema,
  adminCasinoRoundsQuery,
  adminCasinoSessionsQuery,
  casinoKeyParam,
  idParam,
} from '@storm-bet/validation';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context';
import { parse } from '../../lib/validate';
import { requirePermission } from '../../plugins/auth';
import type { CasinoCatalogService } from '../../services/casino';
import { actorOf } from '../request-info';

/** Staff casino management; mutations are audited in the same transaction. */
export function adminCasinoRoutes(ctx: AppContext, catalog: CasinoCatalogService) {
  return async (app: FastifyInstance) => {
    const actor = (request: Parameters<typeof actorOf>[0]) =>
      actorOf(request, ctx.env.AUDIT_LOG_IP);
    const read = (request: Parameters<typeof requirePermission>[0]) =>
      requirePermission(request, Permission.CASINO_READ);
    const manage = (request: Parameters<typeof requirePermission>[0]) =>
      requirePermission(request, Permission.CASINO_MANAGE);

    app.get('/games', async (request) => {
      read(request);
      return catalog.adminGames();
    });
    app.patch('/games/:id', async (request) => {
      manage(request);
      const { id } = parse(idParam, request.params);
      await catalog.updateGame(
        id,
        parse(adminCasinoGameUpdateSchema, request.body),
        actor(request),
      );
      return { ok: true };
    });
    app.get('/categories', async (request) => {
      read(request);
      return catalog.adminCategories();
    });
    app.patch('/categories/:key', async (request) => {
      manage(request);
      const { key } = parse(casinoKeyParam, request.params);
      await catalog.updateCategory(
        key,
        parse(adminCasinoCategoryUpdateSchema, request.body),
        actor(request),
      );
      return { ok: true };
    });
    app.get('/providers', async (request) => {
      read(request);
      return catalog.adminProviders();
    });
    app.patch('/providers/:key', async (request) => {
      manage(request);
      const { key } = parse(casinoKeyParam, request.params);
      await catalog.updateProvider(
        key,
        parse(adminCasinoProviderUpdateSchema, request.body),
        actor(request),
      );
      return { ok: true };
    });
    app.get('/sessions', async (request) => {
      read(request);
      return catalog.adminSessions(parse(adminCasinoSessionsQuery, request.query));
    });
    app.post('/sessions/:id/close', async (request) => {
      manage(request);
      const { id } = parse(idParam, request.params);
      const { reason } = parse(adminCasinoReasonSchema, request.body);
      await ctx.casino.closeSession(id, { actor: actor(request) }, reason);
      return { ok: true };
    });
    app.get('/rounds', async (request) => {
      read(request);
      return catalog.adminRounds(parse(adminCasinoRoundsQuery, request.query));
    });
    app.post('/rounds/:id/refund', async (request) => {
      manage(request);
      const { id } = parse(idParam, request.params);
      const { reason } = parse(adminCasinoReasonSchema, request.body);
      return ctx.casino.refundRound(id, actor(request), reason);
    });
  };
}
