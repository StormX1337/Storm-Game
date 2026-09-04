import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  ErrorCode,
  NodeStatus,
  Permission,
  ServerStatus,
  moveServerSchema,
  paginationQuerySchema,
} from '@storm/types';
import { generatePassword } from '@storm/security';
import { body, params, query } from '../../lib/validation.js';
import { ok, paginated, pageArgs } from '../../lib/response.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { SERVER_INCLUDE } from '../../services/server-access.service.js';
import { toServerSummary } from '../../lib/transformers.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

/**
 * Panel-wide server administration. The customer-facing routes in
 * `servers.routes.ts` scope every query to the caller; these deliberately do
 * not, and are gated behind `admin.servers`.
 */
export default async function adminServerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.requirePermission(Permission.ADMIN_SERVERS));

  app.get('/', { schema: { tags: ['Admin'], summary: 'List every server' } }, async (request) => {
    const q = query(
      request,
      paginationQuerySchema.extend({
        status: z.string().max(32).optional(),
        nodeId: z.string().max(64).optional(),
        ownerId: z.string().max(64).optional(),
        templateId: z.string().max(64).optional(),
        suspended: z.coerce.boolean().optional(),
      }),
    );

    const where = {
      ...(q.status ? { status: q.status as ServerStatus } : {}),
      ...(q.nodeId ? { nodeId: q.nodeId } : {}),
      ...(q.ownerId ? { ownerId: q.ownerId } : {}),
      ...(q.templateId ? { templateId: q.templateId } : {}),
      ...(q.suspended === true ? { suspendedAt: { not: null } } : {}),
      ...(q.suspended === false ? { suspendedAt: null } : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' as const } },
              { shortId: { contains: q.search, mode: 'insensitive' as const } },
              { uuid: { contains: q.search, mode: 'insensitive' as const } },
              { owner: { email: { contains: q.search, mode: 'insensitive' as const } } },
              { owner: { username: { contains: q.search, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };

    const [servers, total] = await Promise.all([
      app.prisma.server.findMany({
        where,
        include: SERVER_INCLUDE,
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q.page, q.perPage),
      }),
      app.prisma.server.count({ where }),
    ]);

    return paginated(servers.map(toServerSummary), total, q.page, q.perPage);
  });

  app.post(
    '/:id/transfer',
    { schema: { tags: ['Admin'], summary: 'Change a server owner' } },
    async (request) => {
      const { id } = params(request, idParam);
      const { ownerId } = body(request, z.object({ ownerId: z.string().min(1).max(64) }));

      const [server, owner] = await Promise.all([
        app.prisma.server.findUnique({ where: { id } }),
        app.prisma.user.findUnique({ where: { id: ownerId } }),
      ]);
      if (!server) throw notFound('Server was not found', ErrorCode.SERVER_NOT_FOUND);
      if (!owner) throw notFound('User was not found', ErrorCode.USER_NOT_FOUND);

      // Ownership is not one column.
      //
      // Everything that opens this server was set up by the person who used to
      // own it, and none of it mentions an owner — so none of it noticed the
      // owner changing. The SFTP credentials they were shown key on the server
      // row alone, which left them full file access to a server that is no
      // longer theirs, indefinitely and invisibly. The shares they handed out
      // are a relationship with *them*, not with whoever holds the server now.
      //
      // Both go, in one transaction with the ownership itself: a transfer that
      // half happened would be worse than one that did not.
      const password = generatePassword(28);
      const [, revoked] = await app.prisma.$transaction([
        app.prisma.server.update({
          where: { id },
          data: { ownerId, sftpPasswordEnc: app.encrypter.encrypt(password) },
        }),
        app.prisma.serverSubuser.deleteMany({ where: { serverId: id } }),
      ]);

      await app.audit.log(request, {
        action: 'admin.server_transferred',
        targetType: 'server',
        targetId: id,
        targetLabel: server.name,
        metadata: {
          from: server.ownerId,
          to: ownerId,
          revokedShares: revoked.count,
          sftpPasswordRotated: true,
        },
      });

      // Database passwords are the third way in, and the only one that needs
      // an engine to be reachable. They are not rotated here: a MySQL host
      // that is down would either block an ownership transfer or leave the
      // operator believing something happened that did not. The panel says so
      // instead, and the rotate button on each database does it.
      const databases = await app.prisma.serverDatabase.count({ where: { serverId: id } });

      return ok({
        transferred: true,
        revokedShares: revoked.count,
        sftpPasswordRotated: true,
        databasesToRotate: databases,
      });
    },
  );

  app.post(
    '/:id/move',
    { schema: { tags: ['Admin'], summary: 'Move a server to another node' } },
    async (request) => {
      const { id } = params(request, idParam);
      const input = body(request, moveServerSchema);

      const [server, destination] = await Promise.all([
        app.prisma.server.findUnique({ where: { id }, include: { node: true } }),
        app.prisma.node.findUnique({ where: { id: input.nodeId } }),
      ]);
      if (!server) throw notFound('Server was not found', ErrorCode.SERVER_NOT_FOUND);
      if (!destination) throw notFound('Node was not found', ErrorCode.NODE_NOT_FOUND);

      if (destination.id === server.nodeId) {
        throw badRequest('That server already runs on this node');
      }
      if (destination.maintenanceMode || destination.status !== NodeStatus.ONLINE) {
        throw conflict(`Node "${destination.name}" is not accepting servers right now`);
      }

      // Only from a settled state. Moving a server mid-install would race the
      // installer against the archive, and two moves at once would have both
      // of them deleting the same source directory.
      const settled: ServerStatus[] = [
        ServerStatus.OFFLINE,
        ServerStatus.ONLINE,
        ServerStatus.CRASHED,
        ServerStatus.SUSPENDED,
      ];
      if (!settled.includes(server.status as ServerStatus)) {
        throw conflict(`A server that is ${server.status.toLowerCase()} cannot be moved yet`);
      }

      await app.servers.assertNodeHasCapacity(destination, server.memoryLimit, server.diskLimit);

      // Checked here rather than discovered by the worker an hour in: the
      // archive has to get from one node's disk to the other's, and that needs
      // somewhere to put it. Object storage is the good route. Without it the
      // panel streams the archive itself, which works but spends its bandwidth
      // twice — so it needs *a* storage row to record the archive against,
      // even the local one.
      const storage = await app.prisma.backupStorage.findFirst({
        where: { isActive: true },
      });
      if (!storage) {
        throw conflict(
          'Moving a server needs somewhere to put the archive it travels in, and no backup ' +
            'storage is configured. Add one under Administration → Backup storage. Shared ' +
            'storage (S3 or compatible) is the faster route; with only local storage the panel ' +
            'streams the archive between the nodes itself.',
        );
      }

      const free = input.allocationId
        ? await app.prisma.serverAllocation.findFirst({
            where: { id: input.allocationId, nodeId: destination.id, serverId: null },
          })
        : await app.prisma.serverAllocation.findFirst({
            where: { nodeId: destination.id, serverId: null },
          });
      if (!free) {
        throw new AppError(
          409,
          ErrorCode.NO_ALLOCATION_AVAILABLE,
          input.allocationId
            ? 'That port is not free on the destination node'
            : `Node "${destination.name}" has no free ports. Add allocations first.`,
        );
      }

      await app.queues.enqueueTransfer({
        serverId: server.id,
        destinationNodeId: destination.id,
        allocationId: input.allocationId ?? null,
        keepBackup: input.keepBackup,
        userId: request.currentUser().id,
      });

      await app.audit.log(request, {
        action: 'admin.server_move_queued',
        targetType: 'server',
        targetId: server.id,
        targetLabel: server.name,
        metadata: { from: server.node.name, to: destination.name },
      });

      return ok({
        queued: true,
        from: server.node.name,
        to: destination.name,
        message:
          'The server is stopped, archived, rebuilt on the new node and restored there. ' +
          'It keeps running on the old node until that succeeds.',
      });
    },
  );

  app.post(
    '/:id/sync',
    { schema: { tags: ['Admin'], summary: 'Re-push the container spec to its node' } },
    async (request) => {
      const { id } = params(request, idParam);
      const server = await app.prisma.server.findUnique({ where: { id } });
      if (!server) throw notFound('Server was not found', ErrorCode.SERVER_NOT_FOUND);

      await app.servers.syncToNode(id);
      await app.audit.log(request, {
        action: 'admin.server_synced',
        targetType: 'server',
        targetId: id,
        targetLabel: server.name,
      });

      return ok({ synced: true });
    },
  );
}
