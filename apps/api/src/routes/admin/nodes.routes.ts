import dns from 'node:dns/promises';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  ErrorCode,
  NodeStatus,
  Permission,
  createAllocationSchema,
  createNodeSchema,
  paginationQuerySchema,
  isBindAddress,
  updateAllocationSchema,
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
import {
  createBootstrapClaim,
  issueNodeConfiguration,
} from '../../services/node-bootstrap.service.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

export default async function adminNodeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);
  app.addHook(
    'preHandler',
    app.requirePermission(Permission.NODES_MANAGE, Permission.ALLOCATIONS_MANAGE),
  );

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

  app.post(
    '/',
    { schema: { tags: ['Admin: Nodes'], summary: 'Register a node' } },
    async (request, reply) => {
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
          node: toNodeDetail(
            { ...node, servers: [], _count: { servers: 0, allocations: 0 } },
            null,
          ),
          token,
        }),
      );
    },
  );

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

  app.post(
    '/:id/tokens',
    { schema: { tags: ['Admin: Nodes'], summary: 'Mint a node token' } },
    async (request) => {
      const { id } = params(request, idParam);
      const input = body(
        request,
        z.object({ name: z.string().trim().min(1).max(64).default('default') }),
      );

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
    },
  );

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

  app.get(
    '/:id/configuration',
    { schema: { tags: ['Admin: Nodes'], summary: 'Agent configuration file' } },
    async (request) => {
      const { id } = params(request, idParam);
      const { config, nodeName } = await issueNodeConfiguration(app, id);

      await app.audit.log(request, {
        action: 'admin.node_configuration_issued',
        targetType: 'node',
        targetId: id,
        targetLabel: nodeName,
      });

      return ok(config);
    },
  );

  app.post(
    '/:id/bootstrap',
    {
      // A claim is worth this node's credentials to whoever holds it. Minting
      // them in bulk is not something an administrator does, and is something
      // a stolen session would.
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
      schema: {
        tags: ['Admin: Nodes'],
        summary: 'A one-line install command the node can redeem itself',
      },
    },
    async (request) => {
      const { id } = params(request, idParam);
      const node = await app.prisma.node.findUnique({ where: { id } });
      if (!node) throw notFound('Node was not found', ErrorCode.NODE_NOT_FOUND);

      const claim = await createBootstrapClaim(app, node.id);

      await app.audit.log(request, {
        action: 'admin.node_bootstrap_issued',
        targetType: 'node',
        targetId: id,
        targetLabel: node.name,
        metadata: { expiresInSeconds: claim.expiresInSeconds },
      });

      // The claim itself is deliberately not returned: the command is what gets
      // copied, and a second copy of the secret is a second place to leak it.
      return ok({ command: claim.command, expiresInSeconds: claim.expiresInSeconds });
    },
  );

  app.get(
    '/:id/health',
    { schema: { tags: ['Admin: Nodes'], summary: 'Query the agent directly' } },
    async (request) => {
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
    },
  );

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
          ? {
              id: allocation.server.id,
              name: allocation.server.name,
              shortId: allocation.server.shortId,
            }
          : null,
      })),
      total,
      q.page,
      q.perPage,
    );
  });

  app.post(
    '/:id/allocations',
    { schema: { tags: ['Admin: Allocations'], summary: 'Add ports' } },
    async (request, reply) => {
      const { id } = params(request, idParam);
      const input = body(request, createAllocationSchema.omit({ nodeId: true }));

      const node = await app.prisma.node.findUnique({ where: { id } });
      if (!node) throw notFound('Node was not found', ErrorCode.NODE_NOT_FOUND);

      // A name is looked up once, here, and the address it answers with is
      // what gets stored — the same bargain Pterodactyl makes with
      // `gethostbyname`, and for the same reason: Docker binds by address and
      // resolves nothing, but the address of a machine is a thing people know
      // by name. Storing the name instead is what broke a real install.
      //
      // The name is kept too, as the alias, when the operator did not give
      // one. Pterodactyl leaves that field empty and the name is simply gone;
      // but somebody who typed `play.example.com` into a field meant an
      // address plainly meant customers to see it, and the alias is exactly
      // where the panel shows customers an address.
      const resolved = await resolveBindAddress(input.ip);
      const alias = input.alias ?? (resolved.fromName ? input.ip : null);

      const ports = new Set<number>(input.ports ?? []);
      if (input.portRangeStart && input.portRangeEnd) {
        if (input.portRangeEnd < input.portRangeStart)
          throw badRequest('The port range is inverted');
        if (input.portRangeEnd - input.portRangeStart > 2000) {
          throw badRequest('A single request may create at most 2000 ports');
        }
        for (let port = input.portRangeStart; port <= input.portRangeEnd; port += 1)
          ports.add(port);
      }
      if (ports.size === 0) throw badRequest('Provide either a list of ports or a port range');

      const result = await app.prisma.serverAllocation.createMany({
        data: [...ports].map((port) => ({
          nodeId: id,
          ip: resolved.address,
          port,
          protocol: input.protocol,
          alias,
        })),
        // Re-adding an existing port is a no-op rather than an error.
        skipDuplicates: true,
      });

      await app.audit.log(request, {
        action: 'admin.allocations_created',
        targetType: 'node',
        targetId: id,
        targetLabel: node.name,
        metadata: {
          ip: resolved.address,
          count: result.count,
          ...(resolved.fromName ? { resolvedFrom: input.ip } : {}),
        },
      });

      return reply.status(201).send(
        ok({
          created: result.count,
          skipped: ports.size - result.count,
          ip: resolved.address,
          alias,
          // So the panel can say "storm.example.com resolved to 1.2.3.4"
          // rather than silently storing something else than was typed.
          resolvedFrom: resolved.fromName ? input.ip : null,
        }),
      );
    },
  );

  app.patch(
    '/:id/allocations/:allocationId',
    { schema: { tags: ['Admin: Allocations'], summary: 'Correct an address or alias' } },
    async (request) => {
      const { id, allocationId } = params(
        request,
        idParam.extend({ allocationId: z.string().min(1) }),
      );
      const input = body(request, updateAllocationSchema);

      const allocation = await app.prisma.serverAllocation.findFirst({
        where: { id: allocationId, nodeId: id },
        include: { server: { select: { id: true, name: true } } },
      });
      if (!allocation) throw notFound('Allocation was not found');

      // Assigned or not. Refusing here is what left an operator with a wrong
      // address they could not change: the delete route already refuses an
      // assigned port, so between the two there was no way to correct one
      // without opening the database.
      const resolved = input.ip === undefined ? null : await resolveBindAddress(input.ip);

      let updated;
      try {
        updated = await app.prisma.serverAllocation.update({
          where: { id: allocationId },
          data: {
            ...(resolved ? { ip: resolved.address } : {}),
            ...(input.alias !== undefined ? { alias: input.alias } : {}),
          },
        });
      } catch (error) {
        // (nodeId, ip, port, protocol) is unique, so moving a port onto an
        // address that already has it collides. The database says so; this
        // says which port.
        if ((error as { code?: string }).code === 'P2002') {
          throw conflict(
            `${resolved?.address ?? allocation.ip}:${allocation.port} already exists on this node`,
          );
        }
        throw error;
      }

      await app.audit.log(request, {
        action: 'admin.allocation_updated',
        targetType: 'node',
        targetId: id,
        metadata: {
          port: allocation.port,
          ...(resolved ? { from: allocation.ip, to: resolved.address } : {}),
          ...(resolved?.fromName ? { resolvedFrom: input.ip } : {}),
          ...(input.alias !== undefined ? { alias: input.alias } : {}),
        },
      });

      return ok({
        allocation: toAllocation(updated),
        resolvedFrom: resolved?.fromName ? (input.ip ?? null) : null,
        // The node holds a container spec built from the old address. Nothing
        // rebinds a running container, so this lands when it next starts —
        // the same bargain the resource limits make.
        appliesOnNextStart: Boolean(allocation.server),
      });
    },
  );

  app.delete(
    '/:id/allocations/:allocationId',
    { schema: { tags: ['Admin: Allocations'] } },
    async (request) => {
      const { id, allocationId } = params(
        request,
        idParam.extend({ allocationId: z.string().min(1) }),
      );

      const allocation = await app.prisma.serverAllocation.findFirst({
        where: { id: allocationId, nodeId: id },
      });
      if (!allocation) throw notFound('Allocation was not found');
      if (allocation.serverId) throw conflict('That port is assigned to a server');

      await app.prisma.serverAllocation.delete({ where: { id: allocationId } });
      return ok({ deleted: true });
    },
  );

  app.post(
    '/:id/allocations/prune',
    { schema: { tags: ['Admin: Allocations'], summary: 'Delete unassigned ports' } },
    async (request) => {
      const { id } = params(request, idParam);
      const result = await app.prisma.serverAllocation.deleteMany({
        where: { nodeId: id, serverId: null },
      });
      await app.audit.log(request, {
        action: 'admin.allocations_pruned',
        targetType: 'node',
        targetId: id,
        metadata: { count: result.count },
      });
      return ok({ deleted: result.count });
    },
  );
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

/** How long a name gets to resolve before the request gives up on it. */
const DNS_TIMEOUT_MS = 5_000;

/**
 * Turns whatever was typed into the address that will be stored.
 *
 * An IP passes straight through. A name is looked up once and the result is
 * what the allocation holds from then on — the panel never resolves it again,
 * and neither does Docker, which cannot. That is a deliberate trade: if the
 * record later points somewhere else, the binding does not follow it. Binding
 * a container's port is not a lookup, it is a claim on an interface that
 * exists at the moment the container starts, so there is nothing to re-resolve
 * against; and an address that silently changed under a running fleet would be
 * far worse than one that is simply out of date and says so.
 *
 * `dns.lookup` rather than `dns.resolve` on purpose: it goes through the
 * system resolver, so /etc/hosts, a search domain and a split-horizon setup
 * all work — which is exactly how an operator's node names usually resolve.
 * `getaddrinfo` has no timeout of its own, hence the race.
 */
async function resolveBindAddress(value: string): Promise<{ address: string; fromName: boolean }> {
  const host = value.trim();
  if (isBindAddress(host)) return { address: host, fromName: false };

  let result;
  try {
    result = await Promise.race([
      dns.lookup(host),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), DNS_TIMEOUT_MS),
      ),
    ]);
  } catch {
    throw badRequest(
      `"${host}" did not resolve to an address. A node binds ports by address — Docker ` +
        'resolves nothing itself — so the name has to be looked up here, and this one could ' +
        'not be. Check the record, or enter the address directly and put the name in the ' +
        'alias field.',
    );
  }

  return { address: result.address, fromName: true };
}
