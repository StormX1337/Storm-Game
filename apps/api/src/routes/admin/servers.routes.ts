import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ErrorCode, Permission, ServerStatus, paginationQuerySchema } from '@storm/types';
import { body, params, query } from '../../lib/validation.js';
import { ok, paginated, pageArgs } from '../../lib/response.js';
import { notFound } from '../../lib/errors.js';
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

      await app.prisma.server.update({ where: { id }, data: { ownerId } });
      await app.audit.log(request, {
        action: 'admin.server_transferred',
        targetType: 'server',
        targetId: id,
        targetLabel: server.name,
        metadata: { from: server.ownerId, to: ownerId },
      });

      return ok({ transferred: true });
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
