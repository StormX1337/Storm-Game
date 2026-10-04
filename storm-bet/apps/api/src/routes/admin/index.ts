import { recordAudit } from '@storm-bet/database';
import { ipAllowed } from '@storm-bet/security';
import { AppError, Permission } from '@storm-bet/types';
import {
  adminAuditListQuery,
  adminBetListQuery,
  adminCreateEventSchema,
  adminEventActionSchema,
  adminEventListQuery,
  adminEventResultSchema,
  adminLockSchema,
  adminMarketActionSchema,
  adminSelectionUpdateSchema,
  adminSetLimitSchema,
  adminSetRoleSchema,
  adminTransactionListQuery,
  adminUnlockSchema,
  adminUpdateEventSchema,
  adminUserListQuery,
  adminVoidBetSchema,
  idParam,
} from '@storm-bet/validation';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context';
import { parse } from '../../lib/validate';
import { requirePermission } from '../../plugins/auth';
import { enforceRateLimit, RATE_LIMITS } from '../../plugins/rate-limit';
import type { AccountService } from '../../services/account';
import type { AdminService } from '../../services/admin';
import type { TwoFactorService } from '../../services/two-factor';
import type { CasinoCatalogService } from '../../services/casino';
import { adminCasinoRoutes } from './casino';
import { actorOf } from '../request-info';

/**
 * Staff API. Every route requires a staff session with the specific
 * permission, is rate limited per staff member, can be restricted to an IP
 * allowlist, and every mutation writes an audit record in the same
 * transaction as the change.
 */
export function adminRoutes(
  ctx: AppContext,
  admin: AdminService,
  accounts: AccountService,
  casino: CasinoCatalogService,
  twoFactor: TwoFactorService,
) {
  const allowlist = ctx.env.ADMIN_IP_ALLOWLIST.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return async (app: FastifyInstance) => {
    app.addHook('preHandler', async (request, reply) => {
      if (!ipAllowed(request.ip, allowlist))
        throw new AppError('FORBIDDEN', 'Zugriff von dieser Adresse nicht erlaubt.');
      const session = requirePermission(request, Permission.ADMIN_ACCESS);
      const write = request.method !== 'GET';
      await enforceRateLimit(
        ctx.redis,
        write ? RATE_LIMITS.adminWrite : RATE_LIMITS.admin,
        session.userId,
        reply,
      );
      reply.header('cache-control', 'no-store');
    });

    const actor = (request: Parameters<typeof actorOf>[0]) =>
      actorOf(request, ctx.env.AUDIT_LOG_IP);

    await app.register(adminCasinoRoutes(ctx, casino), { prefix: '/casino' });

    // Overview & health
    app.get('/overview', async (request) => {
      requirePermission(request, Permission.SYSTEM_READ);
      return admin.overview();
    });
    app.get('/system', async (request) => {
      requirePermission(request, Permission.SYSTEM_READ);
      return admin.systemHealth();
    });
    app.get('/providers', async (request) => {
      requirePermission(request, Permission.PROVIDERS_READ);
      return admin.providers();
    });

    // Users
    app.get('/users', async (request) => {
      requirePermission(request, Permission.USERS_READ);
      return admin.listUsers(parse(adminUserListQuery, request.query));
    });
    app.get('/users/:id', async (request) => {
      requirePermission(request, Permission.USERS_READ);
      return admin.getUser(parse(idParam, request.params).id);
    });
    app.patch('/users/:id/role', async (request) => {
      requirePermission(request, Permission.USERS_ROLES);
      const { id } = parse(idParam, request.params);
      return admin.setRole(actor(request), id, parse(adminSetRoleSchema, request.body));
    });
    app.post('/users/:id/lock', async (request) => {
      requirePermission(request, Permission.USERS_MANAGE);
      const { id } = parse(idParam, request.params);
      return admin.lockUser(actor(request), id, parse(adminLockSchema, request.body).reason);
    });
    app.post('/users/:id/unlock', async (request) => {
      requirePermission(request, Permission.USERS_MANAGE);
      const { id } = parse(idParam, request.params);
      return admin.unlockUser(actor(request), id, parse(adminUnlockSchema, request.body).reason);
    });
    app.put('/users/:id/limits', async (request) => {
      requirePermission(request, Permission.USERS_MANAGE);
      const { id } = parse(idParam, request.params);
      const input = parse(adminSetLimitSchema, request.body);
      await accounts.setLimit(id, input.type, input.amount, actor(request), {
        byStaff: true,
        reason: input.reason,
      });
      return admin.getUser(id);
    });
    app.post('/users/:id/2fa/reset', async (request) => {
      requirePermission(request, Permission.USERS_MANAGE);
      const { id } = parse(idParam, request.params);
      await twoFactor.resetByStaff(
        id,
        actor(request),
        parse(adminUnlockSchema, request.body).reason,
      );
      return admin.getUser(id);
    });
    // Tip feed: take an entry out (e.g. an offensive display name).
    app.delete('/feed/:id', async (request) => {
      requirePermission(request, Permission.USERS_MANAGE);
      const { id } = parse(idParam, request.params);
      const { reason } = parse(adminUnlockSchema, request.body);
      const entry = await ctx.db.sharedBet.findUnique({ where: { id } });
      if (!entry) throw new AppError('NOT_FOUND', 'Eintrag nicht gefunden.');
      await ctx.db.sharedBet.delete({ where: { id } });
      await recordAudit(ctx.db, actor(request), {
        action: 'admin.feed_entry_removed',
        targetType: 'bet',
        targetId: entry.betId,
        metadata: { reason, userId: entry.userId },
      });
      return { ok: true };
    });
    app.post('/users/:id/sessions/revoke', async (request) => {
      requirePermission(request, Permission.USERS_MANAGE);
      return admin.revokeSessions(actor(request), parse(idParam, request.params).id);
    });

    // Events & markets
    app.get('/catalog', async (request) => {
      requirePermission(request, Permission.EVENTS_MANAGE);
      return admin.catalog();
    });
    app.get('/events', async (request) => {
      requirePermission(request, Permission.EVENTS_READ);
      return admin.listEvents(parse(adminEventListQuery, request.query));
    });
    app.get('/events/:id', async (request) => {
      requirePermission(request, Permission.EVENTS_READ);
      return admin.getEvent(parse(idParam, request.params).id);
    });
    app.post('/events', async (request, reply) => {
      requirePermission(request, Permission.EVENTS_MANAGE);
      const event = await admin.createEvent(
        actor(request),
        parse(adminCreateEventSchema, request.body),
      );
      reply.status(201);
      return event;
    });
    app.patch('/events/:id', async (request) => {
      requirePermission(request, Permission.EVENTS_MANAGE);
      const { id } = parse(idParam, request.params);
      return admin.updateEvent(actor(request), id, parse(adminUpdateEventSchema, request.body));
    });
    app.post('/events/:id/actions', async (request) => {
      requirePermission(request, Permission.EVENTS_MANAGE);
      const { id } = parse(idParam, request.params);
      const input = parse(adminEventActionSchema, request.body);
      return admin.eventAction(actor(request), id, input.action, input.reason);
    });
    app.post('/events/:id/result', async (request) => {
      requirePermission(request, Permission.BETS_SETTLE);
      const { id } = parse(idParam, request.params);
      const input = parse(adminEventResultSchema, request.body);
      return admin.setResult(actor(request), id, input.statistics, input.reason);
    });
    app.post('/events/:id/settle', async (request) => {
      requirePermission(request, Permission.BETS_SETTLE);
      return admin.settleEvent(actor(request), parse(idParam, request.params).id);
    });
    app.post('/markets/:id/actions', async (request) => {
      requirePermission(request, Permission.MARKETS_MANAGE);
      const { id } = parse(idParam, request.params);
      return admin.marketAction(actor(request), id, parse(adminMarketActionSchema, request.body));
    });
    app.patch('/selections/:id', async (request) => {
      requirePermission(request, Permission.MARKETS_MANAGE);
      const { id } = parse(idParam, request.params);
      return admin.updateSelection(
        actor(request),
        id,
        parse(adminSelectionUpdateSchema, request.body),
      );
    });

    // Bets, ledger, audit
    app.get('/bets', async (request) => {
      requirePermission(request, Permission.BETS_READ);
      return admin.listBets(parse(adminBetListQuery, request.query));
    });
    app.get('/bets/:id', async (request) => {
      requirePermission(request, Permission.BETS_READ);
      return admin.getBet(parse(idParam, request.params).id);
    });
    app.post('/bets/:id/refund', async (request) => {
      requirePermission(request, Permission.BETS_SETTLE);
      const { id } = parse(idParam, request.params);
      return admin.refundBet(actor(request), id, parse(adminVoidBetSchema, request.body).reason);
    });
    app.post('/bets/:id/settle', async (request) => {
      requirePermission(request, Permission.BETS_SETTLE);
      return admin.settleBet(actor(request), parse(idParam, request.params).id);
    });
    app.get('/transactions', async (request) => {
      requirePermission(request, Permission.TRANSACTIONS_READ);
      return admin.listTransactions(parse(adminTransactionListQuery, request.query));
    });
    app.get('/audit-logs', async (request) => {
      requirePermission(request, Permission.AUDIT_READ);
      return admin.listAudit(parse(adminAuditListQuery, request.query));
    });
  };
}
