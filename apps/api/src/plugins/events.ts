import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import {
  REDIS_CHANNELS,
  type NotificationLevel,
  type NotificationType,
  type ServerLiveStats,
  type ServerStatus,
  type NodeStatus,
} from '@storm/types';

export interface PushNotificationInput {
  type: NotificationType | string;
  title: string;
  message: string;
  level?: NotificationLevel;
  link?: string;
  metadata?: Record<string, unknown>;
}

declare module 'fastify' {
  interface FastifyInstance {
    notifications: {
      push: (userId: string, input: PushNotificationInput) => Promise<void>;
      broadcastServerStatus: (
        serverId: string,
        ownerId: string,
        status: ServerStatus,
      ) => Promise<void>;
      broadcastServerStats: (
        serverId: string,
        ownerId: string,
        stats: ServerLiveStats,
      ) => Promise<void>;
      broadcastNodeStatus: (nodeId: string, status: NodeStatus) => Promise<void>;
    };
  }
}

/**
 * Fan-out for realtime events. Everything goes through Redis pub/sub so that
 * any API replica can deliver to any connected browser, regardless of which
 * replica produced the event.
 */
export default fp(
  async function eventsPlugin(app: FastifyInstance) {
    app.decorate('notifications', {
      async push(userId, input) {
        const notification = await app.prisma.notification.create({
          data: {
            userId,
            type: String(input.type),
            title: input.title,
            message: input.message,
            level: (input.level ?? 'INFO') as never,
            link: input.link ?? null,
            metadata: (input.metadata ?? {}) as object,
          },
        });

        await app.redis.publish(
          REDIS_CHANNELS.notifications,
          JSON.stringify({
            userId,
            notification: {
              id: notification.id,
              title: notification.title,
              message: notification.message,
              level: notification.level,
              link: notification.link,
              createdAt: notification.createdAt.toISOString(),
            },
          }),
        );
      },

      async broadcastServerStatus(serverId, ownerId, status) {
        await app.redis.publish(
          REDIS_CHANNELS.serverStatus,
          JSON.stringify({ serverId, ownerId, status }),
        );
      },

      async broadcastServerStats(serverId, ownerId, stats) {
        await app.redis.publish(
          REDIS_CHANNELS.serverStats,
          JSON.stringify({ serverId, ownerId, stats }),
        );
      },

      async broadcastNodeStatus(nodeId, status) {
        await app.redis.publish(REDIS_CHANNELS.nodeStatus, JSON.stringify({ nodeId, status }));
      },
    });
  },
  { name: 'storm-events', dependencies: ['storm-prisma', 'storm-redis'] },
);
