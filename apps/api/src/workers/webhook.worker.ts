import { Worker } from 'bullmq';
import { request } from 'undici';
import type { FastifyInstance } from 'fastify';
import { QUEUE_NAMES } from '@storm/config';
import { assertSafeUrl, signWebhook } from '@storm/security';
import type { WebhookJobData } from '../plugins/queues.js';
import { concurrency } from './concurrency.js';

/**
 * Delivers a webhook payload.
 *
 * The destination URL is re-validated at delivery time (not just when it was
 * saved) so a hostname that starts resolving to an internal address cannot be
 * used to reach the panel's own network.
 */
export function createWebhookWorker(app: FastifyInstance): Worker<WebhookJobData> {
  return new Worker<WebhookJobData>(
    QUEUE_NAMES.webhooks,
    async (job) => {
      const hook = await app.prisma.webhook.findUnique({ where: { id: job.data.webhookId } });
      if (!hook || !hook.isActive) return;

      const secret = app.encrypter.tryDecrypt(hook.secretEnc) ?? '';
      const body = JSON.stringify(job.data.payload);
      const timestamp = Math.floor(Date.now() / 1000);

      let status = 0;
      let error: string | null = null;

      try {
        await assertSafeUrl(hook.url);
        const response = await request(hook.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'StormPanel-Webhook/1.0',
            'x-storm-event': job.data.event,
            'x-storm-signature': signWebhook(secret, timestamp, body),
            'x-storm-delivery': job.id ?? '',
          },
          body,
          headersTimeout: 10_000,
          bodyTimeout: 10_000,
        });
        status = response.statusCode;
        await response.body.dump();
        if (status >= 400) error = `Endpoint responded with ${status}`;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }

      await app.prisma.$transaction([
        app.prisma.webhookDelivery.create({
          data: {
            webhookId: hook.id,
            event: job.data.event,
            payload: job.data.payload as object,
            status: error ? 'FAILED' : 'SUCCESS',
            responseCode: status || null,
            error: error?.slice(0, 500) ?? null,
            attempt: job.attemptsMade + 1,
          },
        }),
        app.prisma.webhook.update({
          where: { id: hook.id },
          data: {
            lastStatus: status || null,
            lastDeliveryAt: new Date(),
            failureCount: error ? { increment: 1 } : 0,
          },
        }),
      ]);

      // Persistently broken endpoints are disabled so the queue does not fill up.
      if (error && hook.failureCount + 1 >= 25) {
        await app.prisma.webhook.update({ where: { id: hook.id }, data: { isActive: false } });
        app.log.warn({ webhookId: hook.id }, 'webhook disabled after repeated failures');
      }
      if (error) throw new Error(error);
    },
    { connection: { url: app.env.REDIS_URL }, concurrency: concurrency(app, 8) },
  );
}
