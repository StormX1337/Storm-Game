import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { WebhookEvent } from '@storm/types';

declare module 'fastify' {
  interface FastifyInstance {
    webhooks: {
      dispatch: (event: WebhookEvent | string, payload: Record<string, unknown>) => Promise<void>;
    };
  }
}

/**
 * Queues a delivery for every active webhook subscribed to the event. Delivery
 * itself (signing, retries, SSRF checks) happens in the webhook worker so a
 * slow endpoint never blocks an API request.
 */
export default fp(
  async function webhookPlugin(app: FastifyInstance) {
    app.decorate('webhooks', {
      async dispatch(event, payload) {
        try {
          const hooks = await app.prisma.webhook.findMany({
            where: { isActive: true, events: { has: String(event) } },
            select: { id: true },
          });
          if (hooks.length === 0) return;

          const body = { event: String(event), timestamp: new Date().toISOString(), data: payload };
          await Promise.all(
            hooks.map((hook) => app.queues.enqueueWebhook(hook.id, String(event), body)),
          );
        } catch (error) {
          app.log.error({ err: error, event }, 'failed to queue webhook deliveries');
        }
      },
    });
  },
  { name: 'storm-webhooks', dependencies: ['storm-prisma', 'storm-queues'] },
);
