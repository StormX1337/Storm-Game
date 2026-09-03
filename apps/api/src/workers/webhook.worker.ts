import { Worker } from 'bullmq';
import { request } from 'undici';
import type { FastifyInstance } from 'fastify';
import { QUEUE_NAMES } from '@storm/config';
import { NotificationType } from '@storm/types';
import { assertSafeUrl, signWebhook } from '@storm/security';
import type { WebhookJobData } from '../plugins/queues.js';
import { concurrency } from './concurrency.js';

/** How many failed deliveries in a row before the panel stops trying. */
const FAILURES_BEFORE_DISABLED = 25;

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
      await deliver(app, job.data, job.attemptsMade);
    },
    { connection: { url: app.env.REDIS_URL }, concurrency: concurrency(app, 8) },
  );
}

/** Exported so a test can drive one delivery; the worker is its only caller. */
export async function deliver(
  app: FastifyInstance,
  data: WebhookJobData,
  attemptsMade = 0,
): Promise<void> {
  const hook = await app.prisma.webhook.findUnique({ where: { id: data.webhookId } });
  if (!hook || !hook.isActive) return;

  const secret = app.encrypter.tryDecrypt(hook.secretEnc) ?? '';
  const body = JSON.stringify(data.payload);
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
        'x-storm-event': data.event,
        'x-storm-signature': signWebhook(secret, timestamp, body),
        'x-storm-delivery': '',
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

  const [, updated] = await app.prisma.$transaction([
    app.prisma.webhookDelivery.create({
      data: {
        webhookId: hook.id,
        event: data.event,
        payload: data.payload as object,
        status: error ? 'FAILED' : 'SUCCESS',
        responseCode: status || null,
        error: error?.slice(0, 500) ?? null,
        attempt: attemptsMade + 1,
      },
    }),
    app.prisma.webhook.update({
      where: { id: hook.id },
      data: {
        lastStatus: status || null,
        lastDeliveryAt: new Date(),
        failureCount: error ? { increment: 1 } : 0,
        // Back on its feet: a delivery that worked clears the record of
        // having been switched off, so the panel does not keep explaining
        // a state the endpoint has recovered from.
        ...(error ? {} : { disabledAt: null, disabledReason: null }),
      },
    }),
  ]);

  // Persistently broken endpoints are switched off so the queue does not
  // fill up. The count comes back from the write rather than the row read
  // at the top: eight of these run at once, and every one of them would
  // otherwise be deciding on the same stale number.
  if (error && updated.failureCount >= FAILURES_BEFORE_DISABLED) {
    await disable(app, hook.id, hook.name, error);
  }
  if (error) throw new Error(error);
}

/**
 * Switches a broken endpoint off, and says so.
 *
 * Before this it went quiet: the row read `isActive: false`, the panel showed
 * a switch somebody must have flipped, and the reason lived in a log line
 * nobody was tailing. What an operator actually notices is that the deliveries
 * their billing system depends on stopped arriving — days later, and with no
 * way to tell "we gave up" from "somebody turned it off".
 */
async function disable(
  app: FastifyInstance,
  webhookId: string,
  name: string,
  error: string,
): Promise<void> {
  // Only the first job over the line reports it. Eight run at once, and the
  // owner does not need eight notifications about one endpoint.
  const claimed = await app.prisma.webhook.updateMany({
    where: { id: webhookId, isActive: true },
    data: {
      isActive: false,
      disabledAt: new Date(),
      disabledReason: error.slice(0, 500),
    },
  });
  if (claimed.count === 0) return;

  app.log.warn({ webhookId, error }, 'webhook disabled after repeated failures');
  await app.audit.system({
    action: 'webhook.disabled',
    targetType: 'webhook',
    targetId: webhookId,
    targetLabel: name,
    metadata: { error: error.slice(0, 500), failures: FAILURES_BEFORE_DISABLED },
  });

  const admins = await app.prisma.user.findMany({
    where: { role: { name: { in: ['OWNER', 'ADMIN'] } }, suspendedAt: null },
    select: { id: true },
  });
  for (const admin of admins) {
    await app.notifications.push(admin.id, {
      type: NotificationType.SECURITY_EVENT,
      title: 'Webhook switched off',
      message:
        `"${name}" failed ${FAILURES_BEFORE_DISABLED} deliveries in a row and has been switched ` +
        `off: ${error.slice(0, 160)}. Fix the endpoint, then turn it back on under ` +
        'Administration → Webhooks.',
      level: 'ERROR',
      link: '/admin/webhooks',
    });
  }
}
