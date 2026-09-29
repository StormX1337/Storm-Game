import { CSRF_COOKIE, CSRF_HEADER } from '@storm-bet/config/constants';
import { createCsrfToken, safeEqual, verifyCsrfToken } from '@storm-bet/security';
import { AppError } from '@storm-bet/types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface CsrfOptions {
  secret: string;
  appUrl: string;
}

/** What a CSRF token is bound to: the session, or the anonymous visitor. */
export function csrfBinding(request: FastifyRequest): string {
  return request.session ? `session:${request.session.sessionId}` : 'anonymous';
}

export function issueCsrf(
  reply: FastifyReply,
  request: FastifyRequest,
  secret: string,
  appUrl: string,
  binding = csrfBinding(request),
): string {
  const token = createCsrfToken(secret, binding);
  reply.setCookie(CSRF_COOKIE, token, {
    path: '/',
    // Readable by the page: the double-submit pattern needs the script to echo it.
    httpOnly: false,
    sameSite: 'strict',
    secure: appUrl.startsWith('https://'),
  });
  return token;
}

/**
 * CSRF defence in depth for every state-changing request:
 * 1. the Origin (or, failing that, Sec-Fetch-Site) must be our own site;
 * 2. the X-CSRF-Token header must equal the CSRF cookie (double submit);
 * 3. the token must carry a valid HMAC for the current session.
 * SameSite=Lax on the session cookie already stops classic cross-site POSTs.
 */
export const csrfPlugin = fp<CsrfOptions>(async (app: FastifyInstance, { secret, appUrl }) => {
  const allowedOrigin = new URL(appUrl).origin;
  app.addHook('preHandler', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (request.routeOptions.config?.csrf === false) return;

    const origin = request.headers.origin;
    if (origin) {
      if (origin !== allowedOrigin)
        throw new AppError('FORBIDDEN', 'Ungültige Herkunft der Anfrage.');
    } else if (request.headers['sec-fetch-site'] === 'cross-site') {
      throw new AppError('FORBIDDEN', 'Ungültige Herkunft der Anfrage.');
    }

    const header = request.headers[CSRF_HEADER];
    const cookie = request.cookies[CSRF_COOKIE];
    if (typeof header !== 'string' || !cookie || !safeEqual(header, cookie)) {
      throw new AppError(
        'FORBIDDEN',
        'Sicherheitstoken fehlt oder ist abgelaufen. Bitte lade die Seite neu.',
        {
          details: { reason: 'csrf' },
        },
      );
    }
    if (!verifyCsrfToken(secret, csrfBinding(request), header)) {
      throw new AppError('FORBIDDEN', 'Sicherheitstoken ist ungültig. Bitte lade die Seite neu.', {
        details: { reason: 'csrf' },
      });
    }
  });
});

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set to false on endpoints that must accept requests without a CSRF token. */
    csrf?: boolean;
  }
}
