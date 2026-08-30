import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { safeCompare, verifySignature } from '@storm/security';
import { unauthorized } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** preHandler: proves the caller is the panel this node is bound to. */
    verifyPanel: (request: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    /** Raw body text, kept for HMAC verification. */
    rawBody?: string;
  }
}

export interface AgentAuthOptions {
  tokenId: string;
  secret: string;
}

/**
 * Authenticates the panel.
 *
 * The Authorization header carries only the token id; possession of the shared
 * secret is proven by an HMAC over method, path, timestamp and body. That means
 * the secret never travels, and a captured request cannot be replayed against a
 * different endpoint or outside the timestamp window.
 */
export default fp(
  async function agentAuthPlugin(app: FastifyInstance, options: AgentAuthOptions) {
    // Capture the exact bytes the panel signed: re-serialising the parsed body
    // would produce a different string and break verification.
    app.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (request, payload: string, done) => {
        request.rawBody = payload;
        if (!payload) {
          done(null, {});
          return;
        }
        try {
          done(null, JSON.parse(payload) as unknown);
        } catch (error) {
          done(error as Error, undefined);
        }
      },
    );

    app.decorate('verifyPanel', async (request: FastifyRequest) => {
      const header = request.headers.authorization;
      if (!header?.startsWith('Bearer ')) throw unauthorized('Panel credentials are required');

      const tokenId = header.slice(7).trim();
      if (!safeCompare(tokenId, options.tokenId)) {
        throw unauthorized('Unknown panel token');
      }

      const timestamp = request.headers['x-storm-timestamp'];
      const signature = request.headers['x-storm-signature'];
      if (typeof timestamp !== 'string' || typeof signature !== 'string') {
        throw unauthorized('Request signature is missing');
      }

      const url = new URL(request.url, 'http://agent.local');
      const valid = verifySignature(
        options.secret,
        {
          method: request.method,
          path: `${url.pathname}${url.search}`,
          timestamp,
          body: request.rawBody ?? '',
        },
        signature,
      );

      if (!valid) throw unauthorized('Request signature is not valid');
    });
  },
  { name: 'agent-auth' },
);
