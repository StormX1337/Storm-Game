import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  ErrorCode,
  Permission,
  ServerStatus,
  WebhookEvent,
  consoleCommandSchema,
  createServerSchema,
  paginationQuerySchema,
  powerActionSchema,
  reinstallSchema,
  updateServerSchema,
  updateStartupSchema,
  updateVariablesSchema,
  type ServerLiveStats,
} from '@storm/types';
import { generatePassword } from '@storm/security';
import { body, params, query } from '../lib/validation.js';
import { ok, paginated, pageArgs } from '../lib/response.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { ServerAccessService, SERVER_INCLUDE } from '../services/server-access.service.js';
import {
  toActivityLog,
  toAllocation,
  toServerDetail,
  toServerSummary,
} from '../lib/transformers.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

export default async function serverRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  /* ------------------------------------------------------------ list -- */

  app.get(
    '/',
    { schema: { tags: ['Servers'], summary: 'List servers visible to the current user' } },
    async (request) => {
      const user = request.currentUser();
      const q = query(
        request,
        paginationQuerySchema.extend({
          status: z.string().max(32).optional(),
          nodeId: z.string().max(64).optional(),
          /** Admins only: include servers owned by other users. */
          all: z.coerce.boolean().default(false),
        }),
      );

      const canSeeAll = user.role === 'OWNER' || user.permissions.has(Permission.ADMIN_SERVERS);
      const scope =
        q.all && canSeeAll
          ? {}
          : { OR: [{ ownerId: user.id }, { subusers: { some: { userId: user.id } } }] };

      const where = {
        ...scope,
        ...(q.status ? { status: q.status as ServerStatus } : {}),
        ...(q.nodeId ? { nodeId: q.nodeId } : {}),
        ...(q.search
          ? {
              OR: [
                { name: { contains: q.search, mode: 'insensitive' as const } },
                { shortId: { contains: q.search, mode: 'insensitive' as const } },
                { uuid: { contains: q.search, mode: 'insensitive' as const } },
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
    },
  );

  /* ---------------------------------------------------------- create -- */

  app.post(
    '/',
    {
      preHandler: app.requirePermission(Permission.SERVERS_CREATE),
      schema: { tags: ['Servers'], summary: 'Create and install a new server' },
    },
    async (request, reply) => {
      const user = request.currentUser();
      const input = body(request, createServerSchema);

      // Only admins may create servers on behalf of someone else.
      const canAssignOwner = user.role === 'OWNER' || user.permissions.has(Permission.ADMIN_USERS);
      if (input.ownerId && input.ownerId !== user.id && !canAssignOwner) {
        throw forbidden('You cannot create servers for other users');
      }
      const ownerId = input.ownerId ?? user.id;

      const server = await app.servers.create(input, ownerId, user.id);
      await app.audit.log(request, {
        action: 'server.created',
        targetType: 'server',
        targetId: server.id,
        targetLabel: server.name,
        metadata: { nodeId: input.nodeId, templateId: input.templateId },
      });
      await app.audit.activity(request, { serverId: server.id, event: 'server:created' });

      return reply.status(201).send(ok(toServerSummary(server)));
    },
  );

  /* ------------------------------------------------------------- get -- */

  app.get('/:id', { schema: { tags: ['Servers'] } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const access = await app.serverAccess.resolve(user, id);

    const sftp = access.permissions.has(Permission.SERVERS_SFTP)
      ? {
          host: access.server.node.publicIp ?? access.server.node.hostname,
          port: access.server.node.sftpPort,
          username: access.server.sftpUsername,
        }
      : null;

    return ok(toServerDetail(access.server, [...access.permissions], sftp));
  });

  app.patch('/:id', { schema: { tags: ['Servers'] } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const input = body(request, updateServerSchema);
    const access = await app.serverAccess.resolve(user, id);

    // Renaming is a customer action; limits and ownership are admin-only.
    const wantsAdminChange = Boolean(input.limits || input.ownerId);
    if (wantsAdminChange && !access.isAdmin) {
      throw forbidden('Only administrators can change server limits or ownership');
    }
    if (!wantsAdminChange && !access.permissions.has(Permission.SERVERS_UPDATE) && !access.isOwner) {
      throw forbidden('This action requires the servers.update permission');
    }

    if (input.limits) {
      await app.servers.assertNodeHasCapacity(
        access.server.node,
        input.limits.memoryLimit ?? access.server.memoryLimit,
        input.limits.diskLimit ?? access.server.diskLimit,
        access.server.id,
      );
    }

    const updated = await app.prisma.server.update({
      where: { id: access.server.id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
        ...(input.limits ?? {}),
      },
      include: SERVER_INCLUDE,
    });

    // Resource limits live in the container, so the node needs the new spec.
    if (input.limits) {
      await app.servers.syncToNode(access.server.id).catch((error: unknown) => {
        app.log.warn({ err: error, serverId: access.server.id }, 'failed to sync limits to node');
      });
    }

    await app.audit.log(request, {
      action: 'server.updated',
      targetType: 'server',
      targetId: access.server.id,
      targetLabel: updated.name,
      metadata: { fields: Object.keys(input) },
    });
    await app.audit.activity(request, { serverId: access.server.id, event: 'server:updated' });

    return ok(toServerSummary(updated));
  });

  app.delete('/:id', { schema: { tags: ['Servers'], summary: 'Permanently delete a server' } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const input = body(request, z.object({ force: z.boolean().default(false) }).partial());
    const access = await app.serverAccess.resolve(user, id);

    if (!access.isAdmin && !access.isOwner) throw forbidden('Only the owner or an admin can delete a server');
    if (!access.isAdmin && !user.permissions.has(Permission.SERVERS_DELETE)) {
      throw forbidden('This action requires the servers.delete permission');
    }

    const server = access.server;

    try {
      await app.agents.request(server.node, `/api/v1/servers/${server.uuid}`, {
        method: 'DELETE',
        timeoutMs: 60_000,
      });
    } catch (error) {
      // `force` lets an admin remove the database row when the node is gone for
      // good; without it we refuse so we never orphan a running container.
      if (!input.force) {
        throw new AppError(
          503,
          ErrorCode.NODE_UNREACHABLE,
          'The node could not be reached. Retry, or use force to delete the record anyway.',
          { cause: error },
        );
      }
      app.log.warn({ err: error, serverId: server.id }, 'force-deleting server despite node error');
    }

    await app.prisma.$transaction([
      app.prisma.serverAllocation.updateMany({
        where: { serverId: server.id },
        data: { serverId: null, isPrimary: false },
      }),
      app.prisma.server.delete({ where: { id: server.id } }),
    ]);

    await app.audit.log(request, {
      action: 'server.deleted',
      targetType: 'server',
      targetId: server.id,
      targetLabel: server.name,
      metadata: { forced: Boolean(input.force) },
    });
    await app.webhooks.dispatch(WebhookEvent.SERVER_DELETED, {
      serverId: server.id,
      uuid: server.uuid,
      name: server.name,
    });

    return ok({ deleted: true });
  });

  /* ----------------------------------------------------------- power -- */

  app.post('/:id/power', { schema: { tags: ['Servers'], summary: 'Start, stop, restart or kill' } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const { action } = body(request, powerActionSchema);

    const permission = {
      start: Permission.SERVERS_START,
      stop: Permission.SERVERS_STOP,
      restart: Permission.SERVERS_RESTART,
      kill: Permission.SERVERS_KILL,
    }[action];

    const access = await app.serverAccess.require(user, id, permission);
    ServerAccessService.assertNotSuspended(access);
    ServerAccessService.assertInstalled(access);

    await app.servers.sendPower(access.server.id, action);
    await app.audit.activity(request, {
      serverId: access.server.id,
      event: `server:power.${action}`,
    });
    await app.webhooks.dispatch(
      action === 'start' ? WebhookEvent.SERVER_STARTED : WebhookEvent.SERVER_STOPPED,
      { serverId: access.server.id, uuid: access.server.uuid, action },
    );

    return ok({ accepted: true, action });
  });

  app.post('/:id/command', { schema: { tags: ['Servers'], summary: 'Send a console command' } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const { command } = body(request, consoleCommandSchema);

    const access = await app.serverAccess.require(user, id, Permission.SERVERS_COMMAND);
    ServerAccessService.assertNotSuspended(access);

    if (access.server.status !== ServerStatus.ONLINE && access.server.status !== ServerStatus.STARTING) {
      throw new AppError(409, ErrorCode.SERVER_BUSY, 'The server must be running to accept commands');
    }

    await app.agents.request(access.server.node, `/api/v1/servers/${access.server.uuid}/command`, {
      method: 'POST',
      body: { command },
    });
    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'server:console.command',
      metadata: { command: command.slice(0, 200) },
    });

    return ok({ sent: true });
  });

  app.post('/:id/reinstall', { schema: { tags: ['Servers'] } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const input = body(request, reinstallSchema);

    const access = await app.serverAccess.require(user, id, Permission.SERVERS_REINSTALL);
    ServerAccessService.assertNotSuspended(access);

    if (access.server.status === ServerStatus.INSTALLING || access.server.status === ServerStatus.REINSTALLING) {
      throw conflict('This server is already installing');
    }

    await app.queues.enqueueInstall(access.server.id, {
      reinstall: true,
      wipe: input.wipe,
      startOnCompletion: false,
    });
    await app.servers.updateStatus(access.server.id, ServerStatus.REINSTALLING);
    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'server:reinstall',
      metadata: { wipe: input.wipe },
    });

    return ok({ queued: true });
  });

  app.post(
    '/:id/suspend',
    {
      preHandler: app.requirePermission(Permission.SERVERS_SUSPEND),
      schema: { tags: ['Servers'], summary: 'Suspend a server (admin)' },
    },
    async (request) => {
      const user = request.currentUser();
      const { id } = params(request, idParam);
      const access = await app.serverAccess.resolve(user, id);
      if (access.server.suspendedAt) return ok({ suspended: true });

      await app.agents
        .request(access.server.node, `/api/v1/servers/${access.server.uuid}/power`, {
          method: 'POST',
          body: { action: 'stop' },
        })
        .catch((error: unknown) => app.log.warn({ err: error }, 'stop before suspend failed'));

      await app.prisma.server.update({
        where: { id: access.server.id },
        data: { suspendedAt: new Date(), status: ServerStatus.SUSPENDED },
      });
      await app.servers.updateStatus(access.server.id, ServerStatus.SUSPENDED);

      await app.audit.log(request, {
        action: 'server.suspended',
        targetType: 'server',
        targetId: access.server.id,
        targetLabel: access.server.name,
      });
      await app.webhooks.dispatch(WebhookEvent.SERVER_SUSPENDED, {
        serverId: access.server.id,
        uuid: access.server.uuid,
      });

      return ok({ suspended: true });
    },
  );

  app.post(
    '/:id/unsuspend',
    {
      preHandler: app.requirePermission(Permission.SERVERS_SUSPEND),
      schema: { tags: ['Servers'] },
    },
    async (request) => {
      const user = request.currentUser();
      const { id } = params(request, idParam);
      const access = await app.serverAccess.resolve(user, id);

      await app.prisma.server.update({
        where: { id: access.server.id },
        data: { suspendedAt: null, status: ServerStatus.OFFLINE },
      });
      await app.servers.updateStatus(access.server.id, ServerStatus.OFFLINE);

      await app.audit.log(request, {
        action: 'server.unsuspended',
        targetType: 'server',
        targetId: access.server.id,
        targetLabel: access.server.name,
      });
      await app.webhooks.dispatch(WebhookEvent.SERVER_UNSUSPENDED, {
        serverId: access.server.id,
        uuid: access.server.uuid,
      });

      return ok({ suspended: false });
    },
  );

  /* ----------------------------------------------------------- stats -- */

  app.get('/:id/stats', { schema: { tags: ['Servers'], summary: 'Live resource usage' } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_VIEW);

    const cached = await app.redis.get(`storm:server:${access.server.uuid}:stats`);
    if (cached) return ok(JSON.parse(cached) as ServerLiveStats);

    const stats = await app.agents
      .request<ServerLiveStats>(access.server.node, `/api/v1/servers/${access.server.uuid}/stats`, {
        timeoutMs: 5000,
      })
      .catch(() => null);

    if (!stats) {
      return ok({
        cpuPercent: 0,
        cpuLimit: access.server.cpuLimit,
        memoryBytes: 0,
        memoryLimit: access.server.memoryLimit * 1024 * 1024,
        diskBytes: 0,
        diskLimit: access.server.diskLimit * 1024 * 1024,
        networkRx: 0,
        networkTx: 0,
        uptime: 0,
        players: null,
        timestamp: new Date().toISOString(),
      } satisfies ServerLiveStats);
    }
    return ok(stats);
  });

  app.get('/:id/stats/history', { schema: { tags: ['Servers'], summary: 'Historical resource usage' } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const q = query(request, z.object({ hours: z.coerce.number().int().min(1).max(168).default(6) }));
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_VIEW);

    const since = new Date(Date.now() - q.hours * 3600_000);
    const rows = await app.prisma.serverStat.findMany({
      where: { serverId: access.server.id, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      take: 2000,
    });

    return ok(
      rows.map((row) => ({
        t: row.createdAt.toISOString(),
        cpu: row.cpuPercent,
        memory: Number(row.memoryBytes),
        disk: Number(row.diskBytes),
        rx: Number(row.networkRx),
        tx: Number(row.networkTx),
        players: row.players,
      })),
    );
  });

  /* --------------------------------------------------------- startup -- */

  app.patch('/:id/startup', { schema: { tags: ['Servers'], summary: 'Change image or startup command' } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const input = body(request, updateStartupSchema);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_STARTUP);
    ServerAccessService.assertNotSuspended(access);

    if (input.dockerImage) {
      const images = (access.server.template?.dockerImages ?? {}) as Record<string, string>;
      if (!Object.values(images).includes(input.dockerImage)) {
        throw badRequest('That docker image is not offered by this template');
      }
    }

    const updated = await app.prisma.server.update({
      where: { id: access.server.id },
      data: {
        ...(input.dockerImage ? { dockerImage: input.dockerImage } : {}),
        ...(input.startupCommand ? { startupCommand: input.startupCommand } : {}),
      },
      include: SERVER_INCLUDE,
    });

    await app.servers.syncToNode(access.server.id).catch((error: unknown) => {
      app.log.warn({ err: error }, 'failed to sync startup change to node');
    });
    await app.audit.activity(request, { serverId: access.server.id, event: 'server:startup.updated' });

    return ok(toServerDetail(updated, [...access.permissions], null));
  });

  app.put('/:id/variables', { schema: { tags: ['Servers'], summary: 'Update environment variables' } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const input = body(request, updateVariablesSchema);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_VARIABLES);
    ServerAccessService.assertNotSuspended(access);

    const templateVariables = access.server.template?.variables ?? [];
    const current = Object.fromEntries(
      access.server.variables.map((v: { key: string; value: string }) => [v.key, v.value]),
    ) as Record<string, string>;

    // Non-editable variables keep their stored value regardless of what was sent.
    const merged: Record<string, string> = { ...current };
    for (const variable of templateVariables) {
      const submitted = input.variables[variable.envVariable];
      if (submitted !== undefined && variable.userEditable) {
        merged[variable.envVariable] = submitted;
      }
    }

    const environment = app.servers.buildEnvironment(templateVariables, merged, false);

    await app.prisma.$transaction(
      Object.entries(environment).map(([key, value]) =>
        app.prisma.serverVariable.upsert({
          where: { serverId_key: { serverId: access.server.id, key } },
          create: { serverId: access.server.id, key, value },
          update: { value },
        }),
      ),
    );

    await app.servers.syncToNode(access.server.id).catch((error: unknown) => {
      app.log.warn({ err: error }, 'failed to sync variables to node');
    });
    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'server:variables.updated',
      metadata: { keys: Object.keys(environment) },
    });

    const fresh = await app.prisma.server.findUniqueOrThrow({
      where: { id: access.server.id },
      include: SERVER_INCLUDE,
    });
    return ok(toServerDetail(fresh, [...access.permissions], null));
  });

  /* --------------------------------------------------------- network -- */

  app.get('/:id/allocations', { schema: { tags: ['Servers'] } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_ALLOCATIONS, Permission.SERVERS_VIEW);
    return ok(access.server.allocations.map(toAllocation));
  });

  app.post('/:id/allocations', { schema: { tags: ['Servers'], summary: 'Claim an additional port' } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const input = body(request, z.object({ allocationId: z.string().min(1).optional() }));
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_ALLOCATIONS);
    ServerAccessService.assertNotSuspended(access);

    const owner = await app.prisma.user.findUniqueOrThrow({ where: { id: access.server.ownerId } });
    if (owner.allocationLimit > 0 && access.server.allocations.length >= owner.allocationLimit) {
      throw new AppError(
        409,
        ErrorCode.RESOURCE_LIMIT_REACHED,
        `This server may hold at most ${owner.allocationLimit} ports`,
      );
    }

    const claimed = await app.prisma.$transaction(async (tx) => {
      const target = input.allocationId
        ? await tx.serverAllocation.findFirst({
            where: { id: input.allocationId, nodeId: access.server.nodeId, serverId: null },
          })
        : await tx.serverAllocation.findFirst({
            where: { nodeId: access.server.nodeId, serverId: null },
            orderBy: { port: 'asc' },
          });

      if (!target) {
        throw new AppError(409, ErrorCode.NO_ALLOCATION_AVAILABLE, 'No free port is available on this node');
      }

      const result = await tx.serverAllocation.updateMany({
        where: { id: target.id, serverId: null },
        data: { serverId: access.server.id },
      });
      if (result.count === 0) {
        throw new AppError(409, ErrorCode.NO_ALLOCATION_AVAILABLE, 'That port was just taken, try another');
      }
      return tx.serverAllocation.findUniqueOrThrow({ where: { id: target.id } });
    });

    await app.servers.syncToNode(access.server.id).catch(() => undefined);
    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'server:allocation.added',
      metadata: { port: claimed.port },
    });

    return ok(toAllocation(claimed));
  });

  app.delete('/:id/allocations/:allocationId', { schema: { tags: ['Servers'] } }, async (request) => {
    const user = request.currentUser();
    const { id, allocationId } = params(request, idParam.extend({ allocationId: z.string().min(1) }));
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_ALLOCATIONS);

    const allocation = access.server.allocations.find(
      (candidate: { id: string }) => candidate.id === allocationId,
    );
    if (!allocation) throw notFound('Allocation was not found');
    if (allocation.isPrimary) throw badRequest('The primary port cannot be removed');

    await app.prisma.serverAllocation.update({
      where: { id: allocationId },
      data: { serverId: null, isPrimary: false },
    });
    await app.servers.syncToNode(access.server.id).catch(() => undefined);
    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'server:allocation.removed',
      metadata: { port: allocation.port },
    });

    return ok({ removed: true });
  });

  app.post('/:id/allocations/:allocationId/primary', { schema: { tags: ['Servers'] } }, async (request) => {
    const user = request.currentUser();
    const { id, allocationId } = params(request, idParam.extend({ allocationId: z.string().min(1) }));
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_ALLOCATIONS);

    if (!access.server.allocations.some((a: { id: string }) => a.id === allocationId)) {
      throw notFound('Allocation was not found');
    }

    await app.prisma.$transaction([
      app.prisma.serverAllocation.updateMany({
        where: { serverId: access.server.id },
        data: { isPrimary: false },
      }),
      app.prisma.serverAllocation.update({ where: { id: allocationId }, data: { isPrimary: true } }),
    ]);

    await app.servers.syncToNode(access.server.id).catch(() => undefined);
    return ok({ updated: true });
  });

  /* ------------------------------------------------------------ sftp -- */

  app.get('/:id/sftp', { schema: { tags: ['Servers'], summary: 'SFTP connection details' } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_SFTP);

    return ok({
      host: access.server.node.publicIp ?? access.server.node.hostname,
      port: access.server.node.sftpPort,
      username: access.server.sftpUsername,
      // The password is only shown to the owner or an admin, never to sub-users.
      password:
        access.isOwner || access.isAdmin
          ? app.encrypter.tryDecrypt(access.server.sftpPasswordEnc)
          : null,
    });
  });

  app.post('/:id/sftp/reset', { schema: { tags: ['Servers'], summary: 'Rotate the SFTP password' } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_SFTP);
    if (!access.isOwner && !access.isAdmin) throw forbidden('Only the owner can rotate SFTP credentials');

    const password = generatePassword(28);
    await app.prisma.server.update({
      where: { id: access.server.id },
      data: { sftpPasswordEnc: app.encrypter.encrypt(password) },
    });
    await app.audit.activity(request, { serverId: access.server.id, event: 'server:sftp.password_reset' });

    return ok({ username: access.server.sftpUsername, password });
  });

  /* -------------------------------------------------------- activity -- */

  app.get('/:id/activity', { schema: { tags: ['Servers'] } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const q = query(request, paginationQuerySchema);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_ACTIVITY, Permission.SERVERS_VIEW);

    const where = { serverId: access.server.id };
    const [items, total] = await Promise.all([
      app.prisma.activityLog.findMany({
        where,
        include: { user: true },
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q.page, q.perPage),
      }),
      app.prisma.activityLog.count({ where }),
    ]);

    return paginated(items.map(toActivityLog), total, q.page, q.perPage);
  });

  /* -------------------------------------------------------- subusers -- */

  app.get('/:id/subusers', { schema: { tags: ['Servers'] } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_SUBUSERS);

    const subusers = await app.prisma.serverSubuser.findMany({
      where: { serverId: access.server.id },
      include: { user: true },
    });
    return ok(
      subusers.map((subuser) => ({
        id: subuser.id,
        userId: subuser.userId,
        username: subuser.user.username,
        email: subuser.user.email,
        permissions: subuser.permissions,
        createdAt: subuser.createdAt.toISOString(),
      })),
    );
  });

  app.post('/:id/subusers', { schema: { tags: ['Servers'], summary: 'Share a server with another user' } }, async (request) => {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const input = body(
      request,
      z.object({
        email: z.string().email(),
        permissions: z.array(z.string().max(64)).min(1).max(64),
      }),
    );
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_SUBUSERS);

    const target = await app.prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!target) throw notFound('No user with that email address exists', ErrorCode.USER_NOT_FOUND);
    if (target.id === access.server.ownerId) throw badRequest('The owner already has full access');

    // A sub-user can never receive a permission the granting user lacks.
    const permissions = input.permissions.filter((permission) => access.permissions.has(permission));
    if (permissions.length === 0) throw forbidden('You cannot grant any of those permissions');

    const subuser = await app.prisma.serverSubuser.upsert({
      where: { serverId_userId: { serverId: access.server.id, userId: target.id } },
      create: { serverId: access.server.id, userId: target.id, permissions },
      update: { permissions },
    });

    await app.audit.activity(request, {
      serverId: access.server.id,
      event: 'server:subuser.added',
      metadata: { userId: target.id, permissions },
    });

    return ok({ id: subuser.id, userId: target.id, username: target.username, permissions });
  });

  app.delete('/:id/subusers/:subuserId', { schema: { tags: ['Servers'] } }, async (request) => {
    const user = request.currentUser();
    const { id, subuserId } = params(request, idParam.extend({ subuserId: z.string().min(1) }));
    const access = await app.serverAccess.require(user, id, Permission.SERVERS_SUBUSERS);

    await app.prisma.serverSubuser.deleteMany({
      where: { id: subuserId, serverId: access.server.id },
    });
    await app.audit.activity(request, { serverId: access.server.id, event: 'server:subuser.removed' });
    return ok({ removed: true });
  });
}
