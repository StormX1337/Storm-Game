import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hashToken, safeCompare } from '@storm/security';
import { COOKIE_NAMES } from '@storm/config';
import { Permission, ROLE_PRIORITY, type RoleName, ErrorCode } from '@storm/types';
import { verifyJwt, JwtError } from '../lib/jwt.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { AuthService } from '../services/auth.service.js';

export interface AuthenticatedUser {
  id: string;
  uuid: string;
  email: string;
  username: string;
  role: RoleName;
  rolePriority: number;
  permissions: Set<string>;
  sessionId: string | null;
  apiKeyId: string | null;
  suspended: boolean;
  emailVerified: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    auth: AuthService;
    /** preHandler: requires a signed-in, non-suspended user. */
    authenticate: (request: FastifyRequest) => Promise<void>;
    /** preHandler factory: requires the given panel-wide permission. */
    requirePermission: (...permissions: string[]) => (request: FastifyRequest) => Promise<void>;
    /** Resolves a user from a token string (used by the WebSocket handshake). */
    resolveUserFromToken: (token: string) => Promise<AuthenticatedUser>;
    /** Re-derives a user on a long-lived connection; throws if they may no longer be there. */
    refreshUser: (user: AuthenticatedUser) => Promise<AuthenticatedUser>;
  }
  interface FastifyRequest {
    user?: AuthenticatedUser;
    /** Throws unless the request is authenticated. */
    currentUser: () => AuthenticatedUser;
  }
}

const JWT_ISSUER = 'storm-panel';

export default fp(
  async function authPlugin(app: FastifyInstance) {
    app.decorate('auth', new AuthService(app));

    /* ------------------------------------------------ user resolution -- */

    async function loadUser(userId: string, sessionId: string | null, apiKeyId: string | null) {
      const user = await app.prisma.user.findUnique({
        where: { id: userId },
        include: { role: { include: { permissions: true } } },
      });
      if (!user) throw unauthorized('Your account no longer exists');
      if (user.suspendedAt) {
        throw new AppError(403, ErrorCode.ACCOUNT_SUSPENDED, 'This account has been suspended');
      }

      const permissions = new Set<string>(user.role.permissions.map((p) => p.key));
      for (const extra of user.extraPermissions) permissions.add(extra);
      for (const denied of user.deniedPermissions) permissions.delete(denied);

      return {
        id: user.id,
        uuid: user.uuid,
        email: user.email,
        username: user.username,
        role: user.role.name as RoleName,
        rolePriority: ROLE_PRIORITY[user.role.name as RoleName] ?? 0,
        permissions,
        sessionId,
        apiKeyId,
        suspended: Boolean(user.suspendedAt),
        emailVerified: Boolean(user.emailVerifiedAt),
      } satisfies AuthenticatedUser;
    }

    async function fromJwt(token: string): Promise<AuthenticatedUser> {
      let payload;
      try {
        payload = verifyJwt(app.env.JWT_SECRET, token, JWT_ISSUER);
      } catch (error) {
        if (error instanceof JwtError) throw unauthorized(error.message);
        throw error;
      }
      if (payload.typ !== 'access') throw unauthorized('That token cannot be used here');

      // A revoked session must invalidate its access token immediately, so the
      // session row is checked on every request rather than trusted from the JWT.
      const session = await app.prisma.session.findUnique({ where: { id: payload.sid } });
      if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
        throw unauthorized('Your session has expired, please sign in again');
      }

      return loadUser(payload.sub, session.id, null);
    }

    async function fromApiKey(raw: string): Promise<AuthenticatedUser> {
      const [keyId, secret] = raw.split('.', 2);
      if (!keyId || !secret) throw unauthorized('Malformed API key');

      const key = await app.prisma.apiKey.findUnique({ where: { keyId } });
      if (!key || key.revokedAt || (key.expiresAt && key.expiresAt.getTime() < Date.now())) {
        throw unauthorized('That API key is not valid');
      }
      if (!safeCompare(key.keyHash, hashToken(secret))) {
        throw unauthorized('That API key is not valid');
      }

      await app.prisma.apiKey
        .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);

      const user = await loadUser(key.userId, null, key.id);
      return narrowToKey(user, key.permissions);
    }

    /** An API key can only ever narrow the user's permissions. */
    function narrowToKey(user: AuthenticatedUser, scope: string[]): AuthenticatedUser {
      if (scope.length === 0) return user;
      user.permissions = new Set([...user.permissions].filter((p) => scope.includes(p)));
      return user;
    }

    /**
     * Re-derives a user who was authenticated earlier on the same connection.
     *
     * A request resolves its user once and is finished milliseconds later; a
     * websocket resolves once and is then held open for as long as the tab is.
     * That makes "the permissions they had when they connected" a different
     * thing from "the permissions they have", and only the first one was ever
     * being asked about. This is how a long-lived connection asks again: the
     * session or key must still be alive, the account must still exist and not
     * be suspended, and the permission set is rebuilt rather than remembered.
     */
    app.decorate('refreshUser', async (user: AuthenticatedUser): Promise<AuthenticatedUser> => {
      if (user.apiKeyId) {
        const key = await app.prisma.apiKey.findUnique({ where: { id: user.apiKeyId } });
        if (!key || key.revokedAt || (key.expiresAt && key.expiresAt.getTime() < Date.now())) {
          throw unauthorized('That API key is not valid');
        }
        return narrowToKey(await loadUser(key.userId, null, key.id), key.permissions);
      }

      if (user.sessionId) {
        const session = await app.prisma.session.findUnique({ where: { id: user.sessionId } });
        if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
          throw unauthorized('Your session has expired, please sign in again');
        }
      }
      return loadUser(user.id, user.sessionId, null);
    });

    app.decorate('resolveUserFromToken', async (token: string) => {
      if (token.startsWith('storm_')) return fromApiKey(token.slice('storm_'.length));
      return fromJwt(token);
    });

    /* ------------------------------------------------------- decorators -- */

    app.decorateRequest('user', undefined);
    app.decorateRequest('currentUser', function currentUser(this: FastifyRequest) {
      if (!this.user) throw unauthorized();
      return this.user;
    });

    /**
     * Populates `request.user` when credentials are present but never rejects —
     * routes opt in to enforcement with `authenticate`.
     */
    app.addHook('onRequest', async (request) => {
      // Node-agent callbacks carry node credentials, not a user session, and
      // authenticate themselves inside the route. Parsing their header as a
      // JWT here would reject them before they ever reach it.
      if (request.url.includes('/internal/')) return;

      const header = request.headers.authorization;
      let token: string | undefined;

      if (header?.startsWith('Bearer ')) {
        token = header.slice(7).trim();
      } else {
        token = request.cookies[COOKIE_NAMES.accessToken];
      }
      if (!token) return;

      try {
        request.user = await app.resolveUserFromToken(token);
      } catch (error) {
        // Expired cookies are common; surface the failure only when the route
        // actually requires authentication.
        if (header) throw error;
        request.log.debug({ err: error }, 'ignoring invalid session cookie');
      }
    });

    app.decorate('authenticate', async (request: FastifyRequest) => {
      if (!request.user) throw unauthorized();
    });

    app.decorate(
      'requirePermission',
      (...permissions: string[]) =>
        async (request: FastifyRequest) => {
          const user = request.user;
          if (!user) throw unauthorized();
          if (user.role === 'OWNER') return;
          const granted = permissions.some((permission) => user.permissions.has(permission));
          if (!granted) {
            throw forbidden(`This action requires the ${permissions.join(' or ')} permission`);
          }
        },
    );
  },
  { name: 'storm-auth', dependencies: ['storm-env', 'storm-prisma', 'storm-redis'] },
);

/** True when the user may act on resources belonging to other users. */
export function isPanelAdmin(user: AuthenticatedUser): boolean {
  return user.role === 'OWNER' || user.permissions.has(Permission.ADMIN_SERVERS);
}

/**
 * True when the user is shown, and may use, every node the panel has.
 *
 * A node can be marked not public, put in maintenance, or simply be offline,
 * and the deployment list hides all three from a customer. That list is a
 * convenience; this is the rule behind it, so the two cannot drift apart —
 * hiding a node from a dropdown is not the same as refusing to place a server
 * on it, and only the second one is a boundary.
 */
export function canSeeEveryNode(user: AuthenticatedUser): boolean {
  return user.role === 'OWNER' || user.permissions.has(Permission.NODES_MANAGE);
}

/** Guards role escalation: you may never act on someone at or above your level. */
export function assertOutranks(actor: AuthenticatedUser, targetRole: RoleName): void {
  if (actor.role === 'OWNER') return;
  if ((ROLE_PRIORITY[targetRole] ?? 0) >= actor.rolePriority) {
    throw forbidden('You cannot manage an account at or above your own role level');
  }
}
