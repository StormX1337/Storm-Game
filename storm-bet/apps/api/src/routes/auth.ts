import { SESSION_COOKIE } from '@storm-bet/config/constants';
import { AppError } from '@storm-bet/types';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '@storm-bet/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { cookieOptions } from '../lib/cookies';
import { parse } from '../lib/validate';
import { authenticated, requireSession } from '../plugins/auth';
import { issueCsrf } from '../plugins/csrf';
import { enforceRateLimit, RATE_LIMITS } from '../plugins/rate-limit';
import { toSessionUser, type AuthService } from '../services/auth';
import type { SessionService } from '../services/sessions';
import { requestInfo } from './request-info';

export function authRoutes(ctx: AppContext, auth: AuthService, sessions: SessionService) {
  return async (app: FastifyInstance) => {
    const startSession = (
      reply: FastifyReply,
      request: FastifyRequest,
      token: string,
      sessionId: string,
    ) => {
      reply.setCookie(
        SESSION_COOKIE,
        token,
        cookieOptions(ctx.env.APP_URL, ctx.env.SESSION_TTL_HOURS * 3600),
      );
      // Rotate the CSRF token onto the new session (no fixation across login).
      return issueCsrf(
        reply,
        request,
        ctx.env.AUTH_SECRET,
        ctx.env.APP_URL,
        `session:${sessionId}`,
      );
    };

    app.get('/auth/csrf', async (request, reply) => ({
      token: issueCsrf(reply, request, ctx.env.AUTH_SECRET, ctx.env.APP_URL),
    }));

    app.get('/auth/session', async (request) => {
      if (!request.session) return { user: null };
      const user = await ctx.db.user.findUnique({ where: { id: request.session.userId } });
      return { user: user ? toSessionUser(user) : null };
    });

    app.post('/auth/register', async (request, reply) => {
      await enforceRateLimit(ctx.redis, RATE_LIMITS.register, request.ip, reply);
      const input = parse(registerSchema, request.body);
      const { user, token, session } = await auth.register(
        input,
        requestInfo(request, ctx.env.AUDIT_LOG_IP),
      );
      const csrfToken = startSession(reply, request, token, session.id);
      reply.status(201);
      return { user: toSessionUser(user), csrfToken };
    });

    app.post('/auth/login', async (request, reply) => {
      await enforceRateLimit(ctx.redis, RATE_LIMITS.login, request.ip, reply);
      const input = parse(loginSchema, request.body);
      if (request.session) await sessions.revoke(request.session.sessionId, 'replaced by login');
      const { user, token, session } = await auth.login(
        input,
        requestInfo(request, ctx.env.AUDIT_LOG_IP),
      );
      const csrfToken = startSession(reply, request, token, session.id);
      return { user: toSessionUser(user), csrfToken };
    });

    app.post('/auth/logout', async (request, reply) => {
      if (request.session) await sessions.revoke(request.session.sessionId, 'logout');
      reply.clearCookie(SESSION_COOKIE, cookieOptions(ctx.env.APP_URL));
      const csrfToken = issueCsrf(
        reply,
        request,
        ctx.env.AUTH_SECRET,
        ctx.env.APP_URL,
        'anonymous',
      );
      return { ok: true, csrfToken };
    });

    app.post('/auth/logout-all', { preHandler: authenticated }, async (request, reply) => {
      const session = requireSession(request);
      const revoked = await sessions.revokeAll(session.userId, 'logout everywhere');
      reply.clearCookie(SESSION_COOKIE, cookieOptions(ctx.env.APP_URL));
      const csrfToken = issueCsrf(
        reply,
        request,
        ctx.env.AUTH_SECRET,
        ctx.env.APP_URL,
        'anonymous',
      );
      return { ok: true, revoked, csrfToken };
    });

    app.post('/auth/forgot-password', async (request, reply) => {
      await enforceRateLimit(ctx.redis, RATE_LIMITS.passwordReset, request.ip, reply);
      const { email } = parse(forgotPasswordSchema, request.body);
      await auth
        .requestPasswordReset(email)
        .catch((err) => request.log.error({ err }, 'password reset mail failed'));
      reply.status(202);
      return {
        ok: true,
        message: 'Falls ein Konto mit dieser Adresse existiert, haben wir eine E-Mail gesendet.',
      };
    });

    app.post('/auth/reset-password', async (request, reply) => {
      await enforceRateLimit(ctx.redis, RATE_LIMITS.passwordReset, request.ip, reply);
      const input = parse(resetPasswordSchema, request.body);
      await auth.resetPassword(input, requestInfo(request, ctx.env.AUDIT_LOG_IP));
      return { ok: true };
    });

    app.post('/auth/verify-email', async (request, reply) => {
      await enforceRateLimit(ctx.redis, RATE_LIMITS.passwordReset, request.ip, reply);
      const { token } = parse(verifyEmailSchema, request.body);
      await auth.verifyEmail(token);
      return { ok: true };
    });

    app.post('/auth/resend-verification', { preHandler: authenticated }, async (request, reply) => {
      const session = requireSession(request);
      await enforceRateLimit(ctx.redis, RATE_LIMITS.verification, session.userId, reply);
      const user = await ctx.db.user.findUniqueOrThrow({ where: { id: session.userId } });
      if (user.emailVerifiedAt)
        throw new AppError('CONFLICT', 'Deine E-Mail-Adresse ist bereits bestätigt.');
      await auth.sendVerification(user);
      return { ok: true };
    });

    app.post('/auth/change-password', { preHandler: authenticated }, async (request) => {
      const session = requireSession(request);
      const input = parse(changePasswordSchema, request.body);
      const revoked = await auth.changePassword(
        session.userId,
        session.sessionId,
        input,
        requestInfo(request, ctx.env.AUDIT_LOG_IP),
      );
      return { ok: true, otherSessionsRevoked: revoked };
    });
  };
}
