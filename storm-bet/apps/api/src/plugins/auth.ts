import { SESSION_COOKIE } from '@storm-bet/config/constants';
import { AppError, hasPermission, type Permission } from '@storm-bet/types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { SessionRecord, SessionService } from '../services/sessions';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionRecord | null;
  }
}

export interface AuthPluginOptions {
  sessions: SessionService;
}

/** Resolves the session cookie on every request. Routes opt in to requiring it. */
export const authPlugin = fp<AuthPluginOptions>(async (app: FastifyInstance, { sessions }) => {
  app.decorateRequest('session', null);
  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    request.session = token ? await sessions.resolve(token) : null;
  });
});

export function requireSession(request: FastifyRequest): SessionRecord {
  if (!request.session) throw new AppError('UNAUTHORIZED');
  return request.session;
}

export function requirePermission(request: FastifyRequest, permission: Permission): SessionRecord {
  const session = requireSession(request);
  if (!hasPermission(session.role, permission)) throw new AppError('FORBIDDEN');
  return session;
}

/** preHandler form, for route options. */
export const authenticated = async (request: FastifyRequest, _reply: FastifyReply) => {
  requireSession(request);
};

export const permitted =
  (permission: Permission) => async (request: FastifyRequest, _reply: FastifyReply) => {
    requirePermission(request, permission);
  };
