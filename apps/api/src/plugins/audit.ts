import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { redact } from '@storm/security';

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  metadata?: Record<string, unknown>;
}

export interface ActivityEntry {
  serverId: string;
  event: string;
  metadata?: Record<string, unknown>;
}

declare module 'fastify' {
  interface FastifyInstance {
    audit: {
      /** Panel-wide administrative event. */
      log: (request: FastifyRequest | null, entry: AuditEntry, actorId?: string) => Promise<void>;
      /** Server-scoped event shown on the server's Activity tab. */
      activity: (request: FastifyRequest | null, entry: ActivityEntry, userId?: string) => Promise<void>;
      system: (entry: AuditEntry) => Promise<void>;
    };
  }
}

export default fp(
  async function auditPlugin(app: FastifyInstance) {
    app.decorate('audit', {
      async log(request, entry, actorId) {
        const user = request?.user;
        try {
          await app.prisma.auditLog.create({
            data: {
              actorId: actorId ?? user?.id ?? null,
              actorLabel: user?.username ?? null,
              action: entry.action,
              targetType: entry.targetType ?? null,
              targetId: entry.targetId ?? null,
              targetLabel: entry.targetLabel ?? null,
              ip: request?.ip ?? null,
              userAgent: (request?.headers['user-agent'] as string | undefined)?.slice(0, 512) ?? null,
              metadata: redact(entry.metadata ?? {}) as object,
            },
          });
        } catch (error) {
          // Audit failures must never break the operation being audited.
          app.log.error({ err: error, action: entry.action }, 'failed to write audit log');
        }
      },

      async activity(request, entry, userId) {
        try {
          await app.prisma.activityLog.create({
            data: {
              serverId: entry.serverId,
              userId: userId ?? request?.user?.id ?? null,
              event: entry.event,
              ip: request?.ip ?? null,
              metadata: redact(entry.metadata ?? {}) as object,
            },
          });
        } catch (error) {
          app.log.error({ err: error, event: entry.event }, 'failed to write activity log');
        }
      },

      async system(entry) {
        try {
          await app.prisma.auditLog.create({
            data: {
              actorId: null,
              actorLabel: 'system',
              action: entry.action,
              targetType: entry.targetType ?? null,
              targetId: entry.targetId ?? null,
              targetLabel: entry.targetLabel ?? null,
              metadata: redact(entry.metadata ?? {}) as object,
            },
          });
        } catch (error) {
          app.log.error({ err: error, action: entry.action }, 'failed to write system audit log');
        }
      },
    });
  },
  { name: 'storm-audit', dependencies: ['storm-prisma'] },
);
