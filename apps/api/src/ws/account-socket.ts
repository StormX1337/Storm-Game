import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { Permission, REDIS_CHANNELS, type AccountSocketEvent } from '@storm/types';
import { authenticateSocket } from './server-socket.js';

const PING_INTERVAL = 25_000;

/**
 * How stale the socket's answer to "may they see this" is allowed to get.
 *
 * Re-reading on every event would mean a database round trip per resource
 * sample per open dashboard — a lot of queries for a question whose answer
 * changes about once a month. Bounded staleness is the trade, and the point is
 * that it is bounded: before this the answer never expired at all.
 *
 * Exported so a test can wait exactly this long rather than guessing.
 */
export const VISIBILITY_TTL_MS = 10_000;

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

    send(socket, { type: 'ready', userId: user.id });

    /**
     * Who this account is and what it can see, re-read when it goes stale.
     *
     * The cache this replaces only ever filled: a server id that was once
     * visible was never asked about again, and being an administrator was
     * decided at the handshake. So an ex-sub-user kept receiving live status
     * and resource samples — CPU, memory, disk, network — for a server they
     * had been removed from, and a demoted administrator kept a feed of every
     * server and every node on the panel, both for as long as the tab stayed
     * open. A dashboard is left open all day.
     *
     * Null means they may no longer be here at all, which closes the socket.
     */
    let cache: { at: number; ids: Set<string>; isAdmin: boolean } | null = null;

    const visibility = async (): Promise<typeof cache> => {
      if (cache && Date.now() - cache.at < VISIBILITY_TTL_MS) return cache;

      const fresh = await app.refreshUser(user).catch(() => null);
      if (!fresh) {
        socket.close(4403, 'forbidden');
        return null;
      }

      const servers = await app.prisma.server.findMany({
        where: { OR: [{ ownerId: fresh.id }, { subusers: { some: { userId: fresh.id } } }] },
        select: { id: true },
      });
      cache = {
        at: Date.now(),
        ids: new Set(servers.map((server) => server.id)),
        isAdmin: fresh.role === 'OWNER' || fresh.permissions.has(Permission.ADMIN_SERVERS),
      };
      return cache;
    };

    const canSee = async (serverId: string, ownerId?: string): Promise<boolean> => {
      const now = await visibility();
      if (!now) return false;
      if (now.isAdmin) return true;
      if (ownerId === user.id) return true;
      return now.ids.has(serverId);
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
              if (!(await visibility())) return;
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
              const now = await visibility();
              if (!now?.isAdmin) return;
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
