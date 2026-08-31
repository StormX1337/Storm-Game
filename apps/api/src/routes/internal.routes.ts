import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Node } from '@storm/database';
import { hashToken, safeCompare } from '@storm/security';
import {
  NodeStatus,
  NotificationType,
  ServerStatus,
  WebhookEvent,
  type AgentHeartbeat,
  type ServerLiveStats,
} from '@storm/types';
import { body } from '../lib/validation.js';
import { ok } from '../lib/response.js';
import { unauthorized } from '../lib/errors.js';

/**
 * Endpoints the node agent calls back into.
 *
 * Authentication is the reverse of the panel -> agent direction: the agent
 * presents `<tokenId>.<token>` and the panel compares the SHA-256 digest with
 * the stored hash. These routes are never reachable with a user session.
 */
export default async function internalRoutes(app: FastifyInstance): Promise<void> {
  async function authenticateNode(request: FastifyRequest): Promise<Node> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized('Node credentials are required');

    const [tokenId, secret] = header.slice(7).trim().split('.', 2);
    if (!tokenId || !secret) throw unauthorized('Malformed node credentials');

    const record = await app.prisma.nodeToken.findUnique({
      where: { tokenId },
      include: { node: true },
    });
    if (!record || record.revokedAt || (record.expiresAt && record.expiresAt < new Date())) {
      throw unauthorized('Those node credentials are not valid');
    }
    if (!safeCompare(record.tokenHash, hashToken(secret))) {
      throw unauthorized('Those node credentials are not valid');
    }

    await app.prisma.nodeToken
      .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return record.node;
  }

  /* ----------------------------------------------------- heartbeat -- */

  app.post(
    '/heartbeat',
    {
      config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
      schema: { tags: ['Internal'], summary: 'Node agent heartbeat', hide: true },
    },
    async (request) => {
      const node = await authenticateNode(request);
      const payload = request.body as AgentHeartbeat;

      const wasOffline = node.status === NodeStatus.OFFLINE;
      const status = node.maintenanceMode ? NodeStatus.MAINTENANCE : NodeStatus.ONLINE;

      await app.prisma.node.update({
        where: { id: node.id },
        data: {
          status,
          lastHeartbeatAt: new Date(),
          agentVersion: payload.agentVersion,
          dockerVersion: payload.system?.dockerVersion,
          kernel: payload.system?.kernel,
          os: payload.system?.os,
          cpuModel: payload.system?.cpuModel,
          // The agent is authoritative about the hardware it runs on.
          ...(payload.system?.cpuCores ? { cpuCores: payload.system.cpuCores } : {}),
          ...(payload.system?.memoryTotal
            ? { memoryTotal: Math.floor(payload.system.memoryTotal / 1024 / 1024) }
            : {}),
          ...(payload.system?.diskTotal
            ? { diskTotal: Math.floor(payload.system.diskTotal / 1024 / 1024) }
            : {}),
        },
      });

      if (payload.stats) {
        await app.redis.set(
          `storm:node:${node.uuid}:stats`,
          JSON.stringify({
            cpuPercent: payload.stats.cpuPercent,
            memoryUsed: payload.stats.memoryUsed,
            memoryTotal: payload.stats.memoryTotal,
            diskUsed: payload.stats.diskUsed,
            diskTotal: payload.stats.diskTotal,
            networkRx: payload.stats.networkRx,
            networkTx: payload.stats.networkTx,
            containers: payload.stats.containers,
            containersRunning: payload.stats.containersRunning,
            uptime: payload.stats.uptime,
            timestamp: payload.stats.timestamp,
          }),
          'EX',
          120,
        );

        // One time-series row per minute keeps the table bounded without
        // needing a separate downsampling job.
        const minuteKey = `storm:node:${node.uuid}:statwrite`;
        const fresh = await app.redis.set(minuteKey, '1', 'EX', 60, 'NX');
        if (fresh) {
          await app.prisma.nodeStat.create({
            data: {
              nodeId: node.id,
              cpuPercent: payload.stats.cpuPercent,
              memoryUsed: BigInt(Math.round(payload.stats.memoryUsed)),
              memoryTotal: BigInt(Math.round(payload.stats.memoryTotal)),
              diskUsed: BigInt(Math.round(payload.stats.diskUsed)),
              diskTotal: BigInt(Math.round(payload.stats.diskTotal)),
              networkRx: BigInt(Math.round(payload.stats.networkRx)),
              networkTx: BigInt(Math.round(payload.stats.networkTx)),
              containers: payload.stats.containers,
            },
          });
        }
      }

      if (wasOffline) {
        await app.notifications.broadcastNodeStatus(node.id, status);
        await app.audit.system({
          action: 'node.online',
          targetType: 'node',
          targetId: node.id,
          targetLabel: node.name,
        });
        await app.webhooks.dispatch(WebhookEvent.NODE_ONLINE, { nodeId: node.id, name: node.name });
      }

      await reconcileServerStates(app, node, payload.servers ?? []);

      return ok({ acknowledged: true, heartbeatInterval: 20 });
    },
  );

  /* -------------------------------------------------- server events -- */

  app.post(
    '/servers/:uuid/state',
    {
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      schema: { tags: ['Internal'], hide: true },
    },
    async (request) => {
      const node = await authenticateNode(request);
      const { uuid } = request.params as { uuid: string };
      const input = body(
        request,
        z.object({
          status: z.enum([
            'INSTALLING',
            'INSTALL_FAILED',
            'STARTING',
            'ONLINE',
            'STOPPING',
            'OFFLINE',
            'CRASHED',
            'SUSPENDED',
            'REINSTALLING',
          ]),
        }),
      );

      const server = await app.prisma.server.findFirst({ where: { uuid, nodeId: node.id } });
      if (!server) return ok({ ignored: true });

      // A suspended server never leaves that state on the agent's say-so.
      if (server.suspendedAt) return ok({ ignored: true });
      if (server.status === input.status) return ok({ unchanged: true });

      await app.servers.updateStatus(server.id, input.status as ServerStatus);

      if (input.status === ServerStatus.CRASHED) {
        await app.notifications.push(server.ownerId, {
          type: NotificationType.SERVER_CRASHED,
          title: 'Server crashed',
          message: `${server.name} stopped unexpectedly.`,
          level: 'ERROR',
          link: `/servers/${server.shortId}`,
        });
        await app.webhooks.dispatch(WebhookEvent.SERVER_CRASHED, {
          serverId: server.id,
          uuid: server.uuid,
          name: server.name,
        });
      }

      return ok({ updated: true });
    },
  );

  app.post(
    '/servers/:uuid/stats',
    {
      config: { rateLimit: { max: 1200, timeWindow: '1 minute' } },
      schema: { tags: ['Internal'], hide: true },
    },
    async (request) => {
      const node = await authenticateNode(request);
      const { uuid } = request.params as { uuid: string };
      const stats = request.body as ServerLiveStats;

      const server = await app.prisma.server.findFirst({ where: { uuid, nodeId: node.id } });
      if (!server) return ok({ ignored: true });

      await app.redis.set(`storm:server:${uuid}:stats`, JSON.stringify(stats), 'EX', 60);
      await app.notifications.broadcastServerStats(server.id, server.ownerId, stats);

      const minuteKey = `storm:server:${uuid}:statwrite`;
      const fresh = await app.redis.set(minuteKey, '1', 'EX', 60, 'NX');
      if (fresh) {
        await app.prisma.serverStat.create({
          data: {
            serverId: server.id,
            cpuPercent: stats.cpuPercent ?? 0,
            memoryBytes: BigInt(Math.round(stats.memoryBytes ?? 0)),
            diskBytes: BigInt(Math.round(stats.diskBytes ?? 0)),
            networkRx: BigInt(Math.round(stats.networkRx ?? 0)),
            networkTx: BigInt(Math.round(stats.networkTx ?? 0)),
            players: stats.players?.online ?? null,
          },
        });
      }

      return ok({ recorded: true });
    },
  );

  /* ------------------------------------------------------ sftp auth -- */

  app.post(
    '/sftp/auth',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: { tags: ['Internal'], summary: 'Validate SFTP credentials for a node', hide: true },
    },
    async (request) => {
      const node = await authenticateNode(request);
      const input = body(
        request,
        z.object({ username: z.string().min(1).max(128), password: z.string().min(1).max(256) }),
      );

      const server = await app.prisma.server.findFirst({
        where: { sftpUsername: input.username, nodeId: node.id },
        include: { owner: true },
      });
      if (!server) throw unauthorized('Invalid SFTP credentials');

      const expected = app.encrypter.tryDecrypt(server.sftpPasswordEnc);
      if (!expected || !safeCompare(expected, input.password)) {
        throw unauthorized('Invalid SFTP credentials');
      }
      if (server.suspendedAt) throw unauthorized('This server is suspended');
      if (server.owner.suspendedAt) throw unauthorized('This account is suspended');

      await app.audit.activity(
        null,
        { serverId: server.id, event: 'sftp:login', metadata: { username: input.username } },
        server.ownerId,
      );

      return ok({ uuid: server.uuid, serverId: server.id, writable: true });
    },
  );

  /* --------------------------------------------- node configuration -- */

  app.get(
    '/servers',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['Internal'],
        summary: 'Every server specification for this node',
        hide: true,
      },
    },
    async (request) => {
      const node = await authenticateNode(request);
      const servers = await app.prisma.server.findMany({
        where: { nodeId: node.id },
        select: { id: true },
      });

      const specs = await Promise.all(
        servers.map((server) => app.servers.buildAgentSpec(server.id).catch(() => null)),
      );
      return ok(specs.filter((spec) => spec !== null));
    },
  );
}

/**
 * Aligns the panel's view of each server with what the node actually reports.
 * The agent is the source of truth for run state; the panel is the source of
 * truth for suspension and installation.
 */
async function reconcileServerStates(
  app: FastifyInstance,
  node: Node,
  reported: AgentHeartbeat['servers'],
): Promise<void> {
  if (reported.length === 0) return;

  const servers = await app.prisma.server.findMany({
    where: { nodeId: node.id, uuid: { in: reported.map((entry) => entry.uuid) } },
  });
  const byUuid = new Map(servers.map((server) => [server.uuid, server]));

  for (const entry of reported) {
    const server = byUuid.get(entry.uuid);
    if (!server || server.suspendedAt) continue;
    if (server.status === ServerStatus.INSTALLING || server.status === ServerStatus.REINSTALLING)
      continue;
    if (server.status === entry.status) continue;

    await app.servers.updateStatus(server.id, entry.status);
  }
}
