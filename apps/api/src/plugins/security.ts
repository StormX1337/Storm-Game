import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { ErrorCode } from '@storm/types';
import { AppError } from '../lib/errors.js';

/**
 * Transport-level hardening: security headers, CORS allow-listing, signed
 * cookie support and a Redis-backed global rate limiter.
 */
export interface SecurityPluginOptions {
  /** Register the rate limiter. Disabled in tests so suites do not throttle. */
  rateLimit?: boolean;
}

export default fp(
  async function securityPlugin(app: FastifyInstance, options: SecurityPluginOptions) {
    await app.register(helmet, {
      // The API serves JSON and the Swagger UI only; a strict CSP is safe here.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      hsts: app.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    });

    const origins = app.env.CORS_ORIGINS.split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    await app.register(cors, {
      origin(origin, callback) {
        // Same-origin and server-to-server requests carry no Origin header.
        if (!origin) return callback(null, true);
        if (origins.includes('*') || origins.includes(origin)) return callback(null, true);
        return callback(new Error('Origin is not allowed'), false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
      maxAge: 86400,
    });

    await app.register(cookie, {
      secret: app.env.COOKIE_SECRET,
      parseOptions: { sameSite: 'lax', httpOnly: true, path: '/' },
    });

    if (options.rateLimit !== false) {
      await app.register(rateLimit, {
        global: true,
        max: app.env.RATE_LIMIT_MAX,
        timeWindow: app.env.RATE_LIMIT_WINDOW,
        redis: app.redis,
        nameSpace: 'storm:ratelimit:',
        // Authenticated callers get their own bucket so one busy tenant behind
        // a shared NAT cannot rate-limit everyone else.
        keyGenerator: (request) => request.user?.id ?? request.ip,
        allowList: (request) => request.url.startsWith('/health') || request.url.startsWith('/ready'),
        // Returning an AppError (rather than a plain object) keeps the refusal
        // on the normal error path, so it answers 429 with the standard
        // envelope instead of falling through as an unhandled 500.
        errorResponseBuilder: (_request, context) =>
          new AppError(
            429,
            ErrorCode.RATE_LIMITED,
            `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
          ),
      });
    }

  },
  { name: 'storm-security', dependencies: ['storm-env', 'storm-redis'] },
);
