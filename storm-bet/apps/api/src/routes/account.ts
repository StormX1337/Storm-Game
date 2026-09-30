import { AppError, type SessionInfoDto } from '@storm-bet/types';
import {
  idParam,
  selfExclusionSchema,
  setLimitSchema,
  twoFactorCodeSchema,
  twoFactorDisableSchema,
  twoFactorSetupSchema,
  updateProfileSchema,
} from '@storm-bet/validation';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { parse } from '../lib/validate';
import { authenticated, requireSession } from '../plugins/auth';
import type { AccountService } from '../services/account';
import type { SessionService } from '../services/sessions';
import type { TwoFactorService } from '../services/two-factor';
import { actorOf } from './request-info';

export function accountRoutes(
  ctx: AppContext,
  accounts: AccountService,
  sessions: SessionService,
  twoFactor: TwoFactorService,
) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', authenticated);

    // Two-factor login (authenticator app).
    app.get('/account/2fa', async (request) => twoFactor.status(requireSession(request).userId));
    app.post('/account/2fa/setup', async (request) => {
      const { password } = parse(twoFactorSetupSchema, request.body);
      return twoFactor.setup(requireSession(request).userId, password);
    });
    app.post('/account/2fa/enable', async (request) => {
      const { code } = parse(twoFactorCodeSchema, request.body);
      const actor = actorOf(request, ctx.env.AUDIT_LOG_IP);
      return twoFactor.enable(actor.id, code, actor);
    });
    app.post('/account/2fa/disable', async (request) => {
      const { password, code } = parse(twoFactorDisableSchema, request.body);
      const actor = actorOf(request, ctx.env.AUDIT_LOG_IP);
      await twoFactor.disable(actor.id, password, code, actor);
      return { ok: true };
    });
    app.post('/account/2fa/recovery-codes', async (request) => {
      const { code } = parse(twoFactorCodeSchema, request.body);
      const actor = actorOf(request, ctx.env.AUDIT_LOG_IP);
      return twoFactor.regenerateRecoveryCodes(actor.id, code, actor);
    });

    app.get('/account/profile', async (request) =>
      accounts.profile(requireSession(request).userId),
    );

    app.patch('/account/profile', async (request) => {
      const input = parse(updateProfileSchema, request.body);
      const actor = actorOf(request, ctx.env.AUDIT_LOG_IP);
      const profile = await accounts.updateProfile(actor.id, input, actor);
      await sessions.invalidateUser(actor.id);
      return profile;
    });

    app.get('/account/summary', async (request) =>
      accounts.summary(requireSession(request).userId),
    );

    app.get('/account/sessions', async (request): Promise<SessionInfoDto[]> => {
      const session = requireSession(request);
      const rows = await ctx.db.session.findMany({
        where: { userId: session.userId, revokedAt: null, expiresAt: { gt: ctx.now() } },
        orderBy: { lastSeenAt: 'desc' },
        take: 50,
      });
      return rows.map((s) => ({
        id: s.id,
        current: s.id === session.sessionId,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        ip: s.ip,
        userAgent: s.userAgent,
      }));
    });

    app.delete('/account/sessions/:id', async (request) => {
      const session = requireSession(request);
      const { id } = parse(idParam, request.params);
      const target = await ctx.db.session.findFirst({ where: { id, userId: session.userId } });
      if (!target) throw new AppError('NOT_FOUND', 'Sitzung nicht gefunden.');
      await sessions.revoke(id, 'revoked by user');
      return { ok: true };
    });

    app.post('/account/sessions/revoke-others', async (request) => {
      const session = requireSession(request);
      const revoked = await sessions.revokeAll(
        session.userId,
        'revoked by user',
        session.sessionId,
      );
      return { ok: true, revoked };
    });

    app.get('/account/limits', async (request) => accounts.limits(requireSession(request).userId));

    app.put('/account/limits', async (request) => {
      const input = parse(setLimitSchema, request.body);
      const actor = actorOf(request, ctx.env.AUDIT_LOG_IP);
      const result = await accounts.setLimit(actor.id, input.type, input.amount, actor);
      return { ...result, limits: await accounts.limits(actor.id) };
    });

    app.get('/account/self-exclusion', async (request) =>
      accounts.selfExclusion(requireSession(request).userId),
    );

    app.post('/account/self-exclusion', async (request) => {
      const input = parse(selfExclusionSchema, request.body);
      const actor = actorOf(request, ctx.env.AUDIT_LOG_IP);
      return accounts.excludeSelf(actor.id, input, actor);
    });
  };
}
