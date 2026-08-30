import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  ErrorCode,
  NodeStatus,
  Permission,
  createAllocationSchema,
  createNodeSchema,
  paginationQuerySchema,
  updateNodeSchema,
  type AgentSystemInfo,
  type AgentSystemStats,
  type NodeLiveStats,
} from '@storm/types';
import { generateToken, hashToken } from '@storm/security';
import { body, params, query } from '../../lib/validation.js';
import { ok, paginated, pageArgs } from '../../lib/response.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { toAllocation, toNodeDetail, toNodeSummary } from '../../lib/transformers.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

export default async function adminNodeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.requirePermission(Permission.NODES_MANAGE, Permission.ALLOCATIONS_MANAGE));

  /* ------------------------------------------------------------ nodes -- */

  app.get('/', { schema: { tags: ['Admin: Nodes'], summary: 'List nodes' } }, async (request) => {
    const q = query(request, paginationQuerySchema);
    const where = q.search
      ? {
          OR: [
            { name: { contains: q.search, mode: 'insensitive' as const } },
            { hostname: { contains: q.search, mode: 'insensitive' as const } },
            { location: { contains: q.search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [nodes, total] = await Promise.all([
      app.prisma.node.findMany({
        where,
        include: {
          servers: { select: { memoryLimit: true, diskLimit: true } },
          _count: { select: { servers: true, allocations: true } },
        },
        orderBy: { createdAt: 'asc' },
        ...pageArgs(q.page, q.perPage),
      }),
      app.prisma.node.count({ where }),
    ]);

    return paginated(nodes.map(toNodeSummary), total, q.page, q.perPage);
  });

  app.post('/', { schema: { tags: ['Admin: Nodes'], summary: 'Register a node' } }, async (request, reply) => {
    const input = body(request, createNodeSchema);

    const existing = await app.prisma.node.findUnique({ where: { name: input.name } });
    if (existing) throw conflict('A node with that name already exists');

    const node = await app.prisma.node.create({
      data: { ...input, status: NodeStatus.OFFLINE },
    });

    // A node is useless without credentials, so one token is minted up front.
    const token = await mintToken(app, node.id, 'initial');

    await app.audit.log(request, {
      action: 'admin.node_created',
      targetType: 'node',
      targetId: node.id,
      targetLabel: node.name,
    });

    return reply.status(201).send(
      ok({
        node: toNodeDetail({ ...node, servers: [], _count: { servers: 0, allocations: 0 } }, null),
        token,
      }),
    );
  });

  app.get('/:id', { schema: { tags: ['Admin: Nodes'] } }, async (request) => {
    const { id } = params(request, idParam);
    const node = await app.prisma.node.findUnique({
      where: { id },
      include: {
        servers: { select: { memoryLimit: true, diskLimit: true } },
        _count: { select: { servers: true, allocations: true } },
      },
    });
    if (!node) throw notFound('Node was not found', ErrorCode.NODE_NOT_FOUND);

    const cached = await app.redis.get(`storm:node:${node.uuid}:stats`);
    const liveStats = cached ? (JSON.parse(cached) as NodeLiveStats) : null;

    return ok(toNodeDetail(node, liveStats));
  });

  app.patch('/:id', { schema: { tags: ['Admin: Nodes'] } }, async (request) => {
    const { id } = params(request, idParam);
    const input = body(request, updateNodeSchema);

    const node = await app.prisma.node.update({
      where: { id },
      data: input,
      include: {
        servers: { select: { memoryLimit: true, diskLimit: true } },
        _count: { select: { servers: true, allocations: true } },
      },
    });

    await app.audit.log(request, {
      action: 'admin.node_updated',
      targetType: 'node',
      targetId: id,
      targetLabel: node.name,
      metadata: { fields: Object.keys(input) },
    });

    return ok(toNodeDetail(node, null));
  });

  app.delete('/:id', { schema: { tags: ['Admin: Nodes'] } }, async (request) => {
    const { id } = params(request, idParam);
    const node = await app.prisma.node.findUnique({
      where: { id },
      include: { _count: { select: { servers: true } } },
    });
    if (!node) throw notFound('Node was not found', ErrorCode.NODE_NOT_FOUND);
    if (node._count.servers > 0) {
      throw conflict('Move or delete the servers on this node before removing it');
    }

    await app.prisma.node.delete({ where: { id } });
    await app.audit.log(request, {
      action: 'admin.node_deleted',
      targetType: 'node',
      targetId: id,
      targetLabel: node.name,
    });

    return ok({ deleted: true });
  });

  /* ----------------------------------------------------------- tokens -- */

  app.get('/:id/tokens', { schema: { tags: ['Admin: Nodes'] } }, async (request) => {
    const { id } = params(request, idParam);
    const tokens = await app.prisma.nodeToken.findMany({
      where: { nodeId: id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return ok(
      tokens.map((token) => ({
        id: token.id,
        name: token.name,
        tokenId: token.tokenId,
        lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
        expiresAt: token.expiresAt?.toISOString() ?? null,
        createdAt: token.createdAt.toISOString(),
      })),
    );
  });

  app.post('/:id/tokens', { schema: { tags: ['Admin: Nodes'], summary: 'Mint a node token' } }, async (request) => {
    const { id } = params(request, idParam);
    const input = body(request, z.object({ name: z.string().trim().min(1).max(64).default('default') }));

    const node = await app.prisma.node.findUnique({ where: { id } });
    if (!node) throw notFound('Node was not found', ErrorCode.NODE_NOT_FOUND);

    const token = await mintToken(app, id, input.name);
    await app.audit.log(request, {
      action: 'admin.node_token_created',
      targetType: 'node',
      targetId: id,
      targetLabel: node.name,
    });

    return ok(token);
  });

  app.delete('/:id/tokens/:tokenId', { schema: { tags: ['Admin: Nodes'] } }, async (request) => {
    const { id, tokenId } = params(request, idParam.extend({ tokenId: z.string().min(1) }));
    await app.prisma.nodeToken.updateMany({
      where: { id: tokenId, nodeId: id },
      data: { revokedAt: new Date() },
    });
    await app.audit.log(request, {
      action: 'admin.node_token_revoked',
      targetType: 'node',
      targetId: id,
    });
    return ok({ revoked: true });
  });

  app.get('/:id/configuration', { schema: { tags: ['Admin: Nodes'], summary: 'Agent configuration file' } }, async (request) => {
    const { id } = params(request, idParam);
    const node = await app.prisma.node.findUnique({ where: { id } });
    if (!node) throw notFound('Node was not found', ErrorCode.NODE_NOT_FOUND);

    // Issuing configuration always mints a fresh token: the old secret cannot
    // be recovered from the database, only replaced.
    const token = await mintToken(app, node.id, 'configuration');

    const config = [
      `# Storm Node Agent configuration for ${node.name}`,
      `# Generated ${new Date().toISOString()}`,
      `NODE_UUID=${node.uuid}`,
      `PANEL_URL=${app.env.APP_URL}`,
      `AGENT_HOST=0.0.0.0`,
      `AGENT_PORT=${node.agentPort}`,
      `AGENT_TOKEN_ID=${token.tokenId}`,
      `AGENT_TOKEN=${token.token}`,
      `AGENT_SECRET=${token.secret}`,
      `DATA_DIRECTORY=${node.dataDirectory}`,
      `BACKUP_DIRECTORY=${node.backupDirectory}`,
      `SFTP_ENABLED=true`,
      `SFTP_PORT=${node.sftpPort}`,
      `DOCKER_NETWORK=storm_net`,
      `LOG_LEVEL=info`,
    ].join('\n');

    await app.audit.log(request, {
      action: 'admin.node_configuration_issued',
      targetType: 'node',
      targetId: id,
      targetLabel: node.name,
    });

    return ok({ configuration: `${config}\n`, filename: 'storm-agent.env' });
  });

  app.get('/:id/health', { schema: { tags: ['Admin: Nodes'], summary: 'Query the agent directly' } }, async (request) => {
    const { id } = params(request, idParam);
    const node = await app.prisma.node.findUnique({ where: { id } });
    if (!node) throw notFound('Node was not found', ErrorCode.NODE_NOT_FOUND);

    try {
      const [info, stats] = await Promise.all([
        app.agents.request<AgentSystemInfo>(node, '/api/v1/system', { timeoutMs: 8000 }),
        app.agents.request<AgentSystemStats>(node, '/api/v1/system/stats', { timeoutMs: 8000 }),
      ]);

      await app.prisma.node.update({
        where: { id },
        data: {
          status: node.maintenanceMode ? NodeStatus.MAINTENANCE : NodeStatus.ONLINE,
          dockerVersion: info.dockerVersion,
          agentVersion: info.agentVersion,
          kernel: info.kernel,
          os: info.os,
          cpuModel: info.cpuModel,
          lastHeartbeatAt: new Date(),
        },
      });

      return ok({ reachable: true, info, stats });
    } catch (error) {
      return ok({
        reachable: false,
        error: error instanceof AppError ? error.message : 'The agent did not respond',
      });
    }
  });

  /* ------------------------------------------------------ allocations -- */

  app.get('/:id/allocations', { schema: { tags: ['Admin: Allocations'] } }, async (request) => {
    const { id } = params(request, idParam);
    const q = query(
      request,
      paginationQuerySchema.extend({ assigned: z.coerce.boolean().optional() }),
    );

    const where = {
      nodeId: id,
      ...(q.assigned === true ? { serverId: { not: null } } : {}),
      ...(q.assigned === false ? { serverId: null } : {}),
      ...(q.search ? { ip: { contains: q.search } } : {}),
    };

    const [allocations, total] = await Promise.all([
      app.prisma.serverAllocation.findMany({
        where,
        include: { server: { select: { id: true, name: true, shortId: true } } },
        orderBy: [{ ip: 'asc' }, { port: 'asc' }],
        ...pageArgs(q.page, q.perPage),
      }),
      app.prisma.serverAllocation.count({ where }),
    ]);

    return paginated(
      allocations.map((allocation) => ({
        ...toAllocation(allocation),
        server: allocation.server
          ? { id: allocation.server.id, name: allocation.server.name, shortId: allocation.server.shortId }
          : null,
      })),
      total,
      q.page,
      q.perPage,
    );
  });

  app.post('/:id/allocations', { schema: { tags: ['Admin: Allocations'], summary: 'Add ports' } }, async (request, reply) => {
    const { id } = params(request, idParam);
    const input = body(request, createAllocationSchema.omit({ nodeId: true }));

    const node = await app.prisma.node.findUnique({ where: { id } });
    if (!node) throw notFound('Node was not found', ErrorCode.NODE_NOT_FOUND);

    const ports = new Set<number>(input.ports ?? []);
    if (input.portRangeStart && input.portRangeEnd) {
      if (input.portRangeEnd < input.portRangeStart) throw badRequest('The port range is inverted');
      if (input.portRangeEnd - input.portRangeStart > 2000) {
        throw badRequest('A single request may create at most 2000 ports');
      }
      for (let port = input.portRangeStart; port <= input.portRangeEnd; port += 1) ports.add(port);
    }
    if (ports.size === 0) throw badRequest('Provide either a list of ports or a port range');

    const result = await app.prisma.serverAllocation.createMany({
      data: [...ports].map((port) => ({
        nodeId: id,
        ip: input.ip,
        port,
        protocol: input.protocol,
        alias: input.alias ?? null,
      })),
      // Re-adding an existing port is a no-op rather than an error.
      skipDuplicates: true,
    });

    await app.audit.log(request, {
      action: 'admin.allocations_created',
      targetType: 'node',
      targetId: id,
      targetLabel: node.name,
      metadata: { ip: input.ip, count: result.count },
    });

    return reply.status(201).send(ok({ created: result.count, skipped: ports.size - result.count }));
  });

  app.delete('/:id/allocations/:allocationId', { schema: { tags: ['Admin: Allocations'] } }, async (request) => {
    const { id, allocationId } = params(request, idParam.extend({ allocationId: z.string().min(1) }));

    const allocation = await app.prisma.serverAllocation.findFirst({
      where: { id: allocationId, nodeId: id },
    });
    if (!allocation) throw notFound('Allocation was not found');
    if (allocation.serverId) throw conflict('That port is assigned to a server');

    await app.prisma.serverAllocation.delete({ where: { id: allocationId } });
    return ok({ deleted: true });
  });

  app.post('/:id/allocations/prune', { schema: { tags: ['Admin: Allocations'], summary: 'Delete unassigned ports' } }, async (request) => {
    const { id } = params(request, idParam);
    const result = await app.prisma.serverAllocation.deleteMany({ where: { nodeId: id, serverId: null } });
    await app.audit.log(request, {
      action: 'admin.allocations_pruned',
      targetType: 'node',
      targetId: id,
      metadata: { count: result.count },
    });
    return ok({ deleted: result.count });
  });
}

/**
 * Mints a node token. The plaintext token is returned once and only its digest
 * is stored; the HMAC secret is stored encrypted because the panel must be able
 * to re-read it to sign requests.
 */
async function mintToken(
  app: FastifyInstance,
  nodeId: string,
  name: string,
): Promise<{ tokenId: string; token: string; secret: string }> {
  const tokenId = generateToken(8).slice(0, 16);
  const token = generateToken(32);
  const secret = generateToken(32);

  await app.prisma.nodeToken.create({
    data: {
      nodeId,
      name,
      tokenId,
      tokenHash: hashToken(token),
      secretEnc: app.encrypter.encrypt(secret),
    },
  });

  return { tokenId, token, secret };
}
