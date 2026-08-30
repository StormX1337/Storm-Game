import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@storm/database';
import { CUSTOMER_PERMISSIONS, ErrorCode, Permission } from '@storm/types';
import type { AuthenticatedUser } from '../plugins/auth.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';

export const SERVER_INCLUDE = {
  node: true,
  owner: true,
  template: { include: { variables: { orderBy: { sortOrder: 'asc' } } } },
  allocations: { orderBy: [{ isPrimary: 'desc' }, { port: 'asc' }] },
  variables: true,
} satisfies Prisma.ServerInclude;

export interface ServerAccess {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma include shape
  server: any;
  /** Effective permissions this user holds on this specific server. */
  permissions: Set<string>;
  isAdmin: boolean;
  isOwner: boolean;
}

/**
 * Central authorisation gate for every server-scoped route.
 *
 * Resolution order:
 *   1. panel admins (`admin.servers`) get the full customer permission set
 *   2. the owner gets the full customer permission set
 *   3. a sub-user gets exactly the permissions granted on the share
 *   4. everyone else gets a 404 — never a 403, so server ids are not
 *      enumerable by unauthorised callers
 */
export class ServerAccessService {
  constructor(private readonly app: FastifyInstance) {}

  async resolve(user: AuthenticatedUser, serverIdOrUuid: string): Promise<ServerAccess> {
    const server = await this.app.prisma.server.findFirst({
      where: {
        OR: [{ id: serverIdOrUuid }, { uuid: serverIdOrUuid }, { shortId: serverIdOrUuid }],
      },
      include: SERVER_INCLUDE,
    });
    if (!server) throw notFound('Server was not found', ErrorCode.SERVER_NOT_FOUND);

    const isAdmin = user.role === 'OWNER' || user.permissions.has(Permission.ADMIN_SERVERS);
    const isOwner = server.ownerId === user.id;

    if (isAdmin || isOwner) {
      // Admins and owners are still bounded by what their role grants globally,
      // except OWNER which holds everything.
      const permissions =
        user.role === 'OWNER'
          ? new Set<string>(CUSTOMER_PERMISSIONS)
          : new Set<string>(CUSTOMER_PERMISSIONS.filter((p) => user.permissions.has(p)));
      return { server, permissions, isAdmin, isOwner };
    }

    const subuser = await this.app.prisma.serverSubuser.findUnique({
      where: { serverId_userId: { serverId: server.id, userId: user.id } },
    });
    if (!subuser) throw notFound('Server was not found', ErrorCode.SERVER_NOT_FOUND);

    return {
      server,
      permissions: new Set<string>(subuser.permissions),
      isAdmin: false,
      isOwner: false,
    };
  }

  /** Resolve and require one or more permissions on the server. */
  async require(
    user: AuthenticatedUser,
    serverIdOrUuid: string,
    ...permissions: string[]
  ): Promise<ServerAccess> {
    const access = await this.resolve(user, serverIdOrUuid);
    const granted = permissions.some((permission) => access.permissions.has(permission));
    if (!granted) {
      throw forbidden(`This action requires the ${permissions.join(' or ')} permission`);
    }
    return access;
  }

  /** Blocks customer-facing actions on suspended servers; admins are exempt. */
  static assertNotSuspended(access: ServerAccess): void {
    if (access.server.suspendedAt && !access.isAdmin) {
      throw new AppError(
        403,
        ErrorCode.SERVER_SUSPENDED,
        'This server is suspended. Contact support to have it restored.',
      );
    }
  }

  static assertInstalled(access: ServerAccess): void {
    if (!access.server.installedAt) {
      throw new AppError(
        409,
        ErrorCode.SERVER_NOT_INSTALLED,
        'This server is still installing. Please wait for the installation to finish.',
      );
    }
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    serverAccess: ServerAccessService;
  }
}
