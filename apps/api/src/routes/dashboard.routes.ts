import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  ErrorCode,
  NodeStatus,
  Permission,
  ServerStatus,
  type DashboardOverview,
  type NodeLiveStats,
  type ServerLiveStats,
} from '@storm/types';
import { query } from '../lib/validation.js';
import { ok } from '../lib/response.js';
import { notFound } from '../lib/errors.js';
import {
  toActivityLog,
  toNodeSummary,
  toNotification,
  toTemplateDetail,
  toTemplateSummary,
} from '../lib/transformers.js';

/**
 * Read-only endpoints backing the customer dashboard and the server-creation
 * wizard. Nodes and templates are exposed here in a reduced form: a customer
 * needs to pick a location and a game, not to see agent credentials.
 */
export default async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/overview', { schema: { tags: ['Dashboard'], summary: 'Customer dashboard metrics' } }, async (request) => {
    const user = request.currentUser();

    const scope = {
      OR: [{ ownerId: user.id }, { subusers: { some: { userId: user.id } } }],
    };

    const [servers, activity, notifications] = await Promise.all([
      app.prisma.server.findMany({
        where: scope,
        select: {
          id: true,
          uuid: true,
          status: true,
          cpuLimit: true,
          memoryLimit: true,
          diskLimit: true,
          suspendedAt: true,
        },
      }),
      app.prisma.activityLog.findMany({
        where: { server: scope },
        include: { user: true },
        orderBy: { createdAt: 'desc' },
        take: 12,
      }),
      app.prisma.notification.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
    ]);

    // Live usage is read from the Redis cache the heartbeat writes, so the
    // dashboard never fans out to every node on page load.
    const live = await Promise.all(
      servers.map(async (server) => {
        const cached = await app.redis.get(`storm:server:${server.uuid}:stats`);
        return cached ? (JSON.parse(cached) as ServerLiveStats) : null;
      }),
    );

    const resources = servers.reduce(
      (acc, server, index) => {
        const stats = live[index];
        acc.cpuAllocated += server.cpuLimit;
        acc.memoryAllocated += server.memoryLimit * 1024 * 1024;
        acc.diskAllocated += server.diskLimit * 1024 * 1024;
        if (stats) {
          acc.memoryUsed += stats.memoryBytes;
          acc.diskUsed += stats.diskBytes;
          acc.networkRx += stats.networkRx;
          acc.networkTx += stats.networkTx;
        }
        return acc;
      },
      {
        cpuAllocated: 0,
        memoryAllocated: 0,
        memoryUsed: 0,
        diskAllocated: 0,
        diskUsed: 0,
        networkRx: 0,
        networkTx: 0,
      },
    );

    const overview: DashboardOverview = {
      servers: {
        total: servers.length,
        online: servers.filter((server) => server.status === ServerStatus.ONLINE).length,
        offline: servers.filter(
          (server) => server.status === ServerStatus.OFFLINE || server.status === ServerStatus.CRASHED,
        ).length,
        suspended: servers.filter((server) => server.suspendedAt !== null).length,
        installing: servers.filter(
          (server) =>
            server.status === ServerStatus.INSTALLING || server.status === ServerStatus.REINSTALLING,
        ).length,
      },
      resources,
      recentActivity: activity.map(toActivityLog),
      notifications: notifications.map(toNotification),
    };

    return ok(overview);
  });

  /* ------------------------------------------------- nodes (read-only) -- */

  app.get('/nodes', { schema: { tags: ['Nodes'], summary: 'Nodes available for deployment' } }, async (request) => {
    const user = request.currentUser();
    const canSeeAll = user.role === 'OWNER' || user.permissions.has(Permission.NODES_MANAGE);

    const nodes = await app.prisma.node.findMany({
      where: canSeeAll ? {} : { isPublic: true, maintenanceMode: false, status: NodeStatus.ONLINE },
      include: {
        servers: { select: { memoryLimit: true, diskLimit: true } },
        _count: { select: { servers: true, allocations: true } },
      },
      orderBy: { name: 'asc' },
    });

    const withCapacity = await Promise.all(
      nodes.map(async (node) => {
        const freePorts = await app.prisma.serverAllocation.count({
          where: { nodeId: node.id, serverId: null },
        });
        const summary = toNodeSummary(node);
        return {
          ...summary,
          freeAllocations: freePorts,
          availableMemory: Math.max(
            0,
            Math.floor(node.memoryTotal * (1 + node.memoryOvercommit / 100)) - summary.allocatedMemory,
          ),
          availableDisk: Math.max(
            0,
            Math.floor(node.diskTotal * (1 + node.diskOvercommit / 100)) - summary.allocatedDisk,
          ),
        };
      }),
    );

    return ok(withCapacity);
  });

  app.get('/nodes/:id/stats', { schema: { tags: ['Nodes'], summary: 'Live node utilisation' } }, async (request) => {
    const user = request.currentUser();
    const { id } = request.params as { id: string };

    const node = await app.prisma.node.findUnique({ where: { id } });
    if (!node) throw notFound('Node was not found', ErrorCode.NODE_NOT_FOUND);

    const canSeeAll = user.role === 'OWNER' || user.permissions.has(Permission.NODES_MANAGE);
    if (!canSeeAll) {
      // A customer may only inspect a node they actually have a server on.
      const owns = await app.prisma.server.count({ where: { nodeId: id, ownerId: user.id } });
      if (owns === 0) throw notFound('Node was not found', ErrorCode.NODE_NOT_FOUND);
    }

    const cached = await app.redis.get(`storm:node:${node.uuid}:stats`);
    const history = await app.prisma.nodeStat.findMany({
      where: { nodeId: id, createdAt: { gte: new Date(Date.now() - 6 * 3600_000) } },
      orderBy: { createdAt: 'asc' },
      take: 720,
    });

    return ok({
      live: cached ? (JSON.parse(cached) as NodeLiveStats) : null,
      history: history.map((row) => ({
        t: row.createdAt.toISOString(),
        cpu: row.cpuPercent,
        memory: Number(row.memoryUsed),
        disk: Number(row.diskUsed),
        rx: Number(row.networkRx),
        tx: Number(row.networkTx),
        containers: row.containers,
      })),
    });
  });

  /* --------------------------------------------- templates (read-only) -- */

  app.get('/templates', { schema: { tags: ['Templates'], summary: 'Game templates available to customers' } }, async (request) => {
    const q = query(
      request,
      z.object({
        category: z.string().max(64).optional(),
        search: z.string().max(100).optional(),
      }),
    );

    const templates = await app.prisma.gameTemplate.findMany({
      where: {
        isActive: true,
        ...(q.category ? { category: q.category } : {}),
        ...(q.search
          ? {
              OR: [
                { name: { contains: q.search, mode: 'insensitive' as const } },
                { game: { contains: q.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      include: { _count: { select: { servers: true } } },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });

    return ok(templates.map(toTemplateSummary));
  });

  app.get('/templates/:id', { schema: { tags: ['Templates'] } }, async (request) => {
    const { id } = request.params as { id: string };
    const template = await app.prisma.gameTemplate.findFirst({
      where: { OR: [{ id }, { slug: id }], isActive: true },
      include: { variables: { orderBy: { sortOrder: 'asc' } }, _count: { select: { servers: true } } },
    });
    if (!template) throw notFound('Template was not found', ErrorCode.TEMPLATE_NOT_FOUND);

    const detail = toTemplateDetail(template);
    // Install scripts can embed credentials for private registries; customers
    // only ever need the fields that drive the creation wizard.
    return ok({
      ...detail,
      installScript: '',
      variables: detail.variables.filter((variable) => variable.userViewable),
    });
  });

  app.get('/templates/meta/categories', { schema: { tags: ['Templates'] } }, async () => {
    const rows = await app.prisma.gameTemplate.groupBy({
      by: ['category'],
      where: { isActive: true },
      _count: { _all: true },
    });
    return ok(
      rows
        .map((row) => ({ category: row.category, count: row._count._all }))
        .sort((a, b) => a.category.localeCompare(b.category)),
    );
  });
}
