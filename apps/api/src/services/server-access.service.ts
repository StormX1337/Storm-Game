import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@storm/database';
import {
  CUSTOMER_PERMISSIONS,
  ErrorCode,
  Permission,
  ServerStatus,
  isInstallBusy,
} from '@storm/types';
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
 *   3. a sub-user gets the permissions granted on the share, bounded by what
 *      their own account is allowed
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
      // Bounded by what this caller actually holds right now: their role, plus
      // what was granted to the account, minus what was denied it — and
      // narrowed again when they are acting through a scoped API key.
      //
      // The OWNER role used to skip that and take the whole customer set. It
      // holds every permission anyway, so for a signed-in owner nothing
      // changes; what it did skip was the narrowing, which is how an API key
      // scoped to "view servers" could still delete one.
      const permissions = new Set<string>(
        CUSTOMER_PERMISSIONS.filter((permission) => user.permissions.has(permission)),
      );
      return { server, permissions, isAdmin, isOwner };
    }

    const subuser = await this.app.prisma.serverSubuser.findUnique({
      where: { serverId_userId: { serverId: server.id, userId: user.id } },
    });
    if (!subuser) throw notFound('Server was not found', ErrorCode.SERVER_NOT_FOUND);

    // A share is a ceiling, not a source: the most this person can do here is
    // what the owner granted, and they still have to be allowed to do it at
    // all. This branch used to take the share on its own, so a denial an
    // administrator had set on the account — "this person may not send console
    // commands" — stopped applying the moment somebody shared a server with
    // them, and a scoped API key was ignored here entirely.
    const permissions = new Set<string>(
      subuser.permissions.filter((permission) => user.permissions.has(permission)),
    );

    return { server, permissions, isAdmin: false, isOwner: false };
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

  /**
   * Blocks anything that would touch the files while a job owns them.
   *
   * `installedAt` alone was never the whole answer: it stays set through a
   * reinstall and through a move, so a server whose directory was being wiped,
   * rebuilt or copied to another machine still read as installed and could be
   * started underneath the job doing the work.
   */
  static assertInstalled(access: ServerAccess): void {
    if (!access.server.installedAt) {
      throw new AppError(
        409,
        ErrorCode.SERVER_NOT_INSTALLED,
        'This server is still installing. Please wait for the installation to finish.',
      );
    }
    if (isInstallBusy(access.server.status as ServerStatus)) {
      throw new AppError(409, ErrorCode.SERVER_NOT_INSTALLED, busyMessage(access.server.status));
    }
  }
}

/** Says which job is holding the files, so the answer is not just "no". */
export function busyMessage(status: ServerStatus): string {
  switch (status) {
    case ServerStatus.REINSTALLING:
      return 'This server is being reinstalled. Wait for the reinstall to finish.';
    case ServerStatus.INSTALL_FAILED:
      return 'This server did not finish installing. Reinstall it before using it again.';
    case ServerStatus.TRANSFERRING:
      return 'This server is being moved to another node. Wait for the move to finish.';
    default:
      return 'This server is still installing. Please wait for the installation to finish.';
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    serverAccess: ServerAccessService;
  }
}
