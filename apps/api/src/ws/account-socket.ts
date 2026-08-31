import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { Permission, REDIS_CHANNELS, type AccountSocketEvent } from '@storm/types';
import { authenticateSocket } from './server-socket.js';

const PING_INTERVAL = 25_000;

/**
 * Account-wide socket that powers live dashboard tiles and the notification
 * bell. One Redis subscription per connection keeps the fan-out simple; each
 * message is filtered so a user only ever receives events about their own
 * servers (or every server, for panel admins).
 */
export async function registerAccountSocket(app: FastifyInstance): Promise<void> {
  app.get('/ws', { websocket: true, schema: { hide: true } }, async (socket, request) => {
    let user;
    try {
      user = await authenticateSocket(
        app,
        request.query as Record<string, string>,
        request.headers.cookie,
      );
    } catch {
      socket.close(4401, 'unauthenticated');
      return;
    }

    const isAdmin = user.role === 'OWNER' || user.permissions.has(Permission.ADMIN_SERVERS);
    send(socket, { type: 'ready', userId: user.id });

    // Servers the user can see; refreshed lazily when an unknown id arrives.
    let visible = new Set(
      (
        await app.prisma.server.findMany({
          where: { OR: [{ ownerId: user.id }, { subusers: { some: { userId: user.id } } }] },
          select: { id: true },
        })
      ).map((server) => server.id),
    );
    let lastRefresh = Date.now();

    const canSee = async (serverId: string, ownerId?: string): Promise<boolean> => {
      if (isAdmin) return true;
      if (ownerId === user.id) return true;
      if (visible.has(serverId)) return true;
      // A server created after the socket opened would otherwise stay invisible
      // until reconnect; re-read at most once every 30 seconds.
      if (Date.now() - lastRefresh < 30_000) return false;
      lastRefresh = Date.now();
      visible = new Set(
        (
          await app.prisma.server.findMany({
            where: { OR: [{ ownerId: user.id }, { subusers: { some: { userId: user.id } } }] },
            select: { id: true },
          })
        ).map((server) => server.id),
      );
      return visible.has(serverId);
    };

    const subscriber = app.createRedis();
    await subscriber.subscribe(
      REDIS_CHANNELS.notifications,
      REDIS_CHANNELS.serverStatus,
      REDIS_CHANNELS.serverStats,
      REDIS_CHANNELS.nodeStatus,
    );

    subscriber.on('message', (channel: string, payload: string) => {
      void (async () => {
        try {
          const parsed = JSON.parse(payload) as Record<string, never>;

          switch (channel) {
            case REDIS_CHANNELS.notifications: {
              if ((parsed as { userId?: string }).userId !== user.id) return;
              send(socket, {
                type: 'notification',
                notification: (parsed as never as { notification: never }).notification,
              });
              return;
            }
            case REDIS_CHANNELS.serverStatus: {
              const event = parsed as never as { serverId: string; ownerId: string; status: never };
              if (!(await canSee(event.serverId, event.ownerId))) return;
              send(socket, {
                type: 'server:status',
                serverId: event.serverId,
                status: event.status,
              });
              return;
            }
            case REDIS_CHANNELS.serverStats: {
              const event = parsed as never as { serverId: string; ownerId: string; stats: never };
              if (!(await canSee(event.serverId, event.ownerId))) return;
              send(socket, { type: 'server:stats', serverId: event.serverId, stats: event.stats });
              return;
            }
            case REDIS_CHANNELS.nodeStatus: {
              if (!isAdmin) return;
              const event = parsed as never as { nodeId: string; status: never };
              send(socket, { type: 'node:status', nodeId: event.nodeId, status: event.status });
              return;
            }
            default:
              return;
          }
        } catch (error) {
          app.log.debug({ err: error }, 'failed to relay socket event');
        }
      })();
    });

    socket.on('message', (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString()) as { type?: string };
        if (message.type === 'ping') send(socket, { type: 'pong' });
      } catch {
        /* ignore malformed frames */
      }
    });

    const heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, PING_INTERVAL);

    socket.on('close', () => {
      clearInterval(heartbeat);
      void subscriber.quit().catch(() => undefined);
    });
  });
}

function send(socket: WebSocket, event: AccountSocketEvent): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
}
