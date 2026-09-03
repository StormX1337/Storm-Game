import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { NotificationType, WebhookEvent } from '@storm/types';
import { hashPassword } from '@storm/security';
import { deliver } from '../src/workers/webhook.worker.js';
import { createTestApp, deleteUser, uniqueSuffix } from './helpers.js';

/**
 * A webhook that gives up says so.
 *
 * An endpoint that keeps failing is switched off, or the queue fills with
 * deliveries to a host that will never answer. That part was right. What was
 * missing is that it went quiet: the row read `isActive: false`, the page
 * showed a switch somebody must have flipped, and the reason lived in a log
 * line nobody was tailing.
 *
 * What an operator actually notices is that the deliveries their billing runs
 * on stopped arriving — days later, with no way to tell "we gave up" from
 * "somebody turned it off".
 */
describe('a webhook the panel switches off', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let adminToken: string;
  let ownerId: string;
  let webhookId: string;
  const createdUsers: string[] = [];

  const FAILURES = 25;
  /** Never resolves, so a delivery fails without reaching anything real. */
  const DEAD_URL = 'https://storm-test-endpoint.invalid/hook';

  const payload = { webhookId: '', event: WebhookEvent.SERVER_CREATED, payload: { a: 1 } };

  async function attempt(): Promise<void> {
    await deliver(app, { ...payload, webhookId }).catch(() => undefined);
  }

  async function read() {
    return app.prisma.webhook.findUniqueOrThrow({ where: { id: webhookId } });
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    const suffix = uniqueSuffix();
    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const owner = await app.prisma.user.create({
      data: {
        email: `hook-owner-${suffix}@storm.test`,
        username: `hookowner${suffix}`,
        passwordHash: await hashPassword('OwnerPassword123!'),
        roleId: ownerRole.id,
        emailVerifiedAt: new Date(),
      },
    });
    ownerId = owner.id;
    createdUsers.push(owner.id);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: owner.email, password: 'OwnerPassword123!' },
    });
    adminToken = login.json<{ data: { accessToken: string } }>().data.accessToken;

    const hook = await app.prisma.webhook.create({
      data: {
        name: `Billing ${suffix}`,
        url: DEAD_URL,
        secretEnc: app.encrypter.encrypt('a-shared-secret'),
        events: [WebhookEvent.SERVER_CREATED],
      },
    });
    webhookId = hook.id;
  });

  after(async () => {
    await app.prisma.webhookDelivery.deleteMany({ where: { webhookId } });
    await app.prisma.webhook.delete({ where: { id: webhookId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    await app.prisma.webhookDelivery.deleteMany({ where: { webhookId } });
    await app.prisma.notification.deleteMany({ where: { userId: ownerId } });
    await app.prisma.webhook.update({
      where: { id: webhookId },
      data: {
        isActive: true,
        failureCount: 0,
        disabledAt: null,
        disabledReason: null,
        url: DEAD_URL,
      },
    });
  });

  it('keeps trying while the endpoint has not used up its rope', async () => {
    await app.prisma.webhook.update({
      where: { id: webhookId },
      data: { failureCount: FAILURES - 2 },
    });
    await attempt();

    const hook = await read();
    assert.equal(hook.isActive, true, 'gave up early');
    assert.equal(hook.failureCount, FAILURES - 1);
    assert.equal(hook.disabledAt, null);
  });

  it('switches off after enough failures, and records what it was failing on', async () => {
    await app.prisma.webhook.update({
      where: { id: webhookId },
      data: { failureCount: FAILURES - 1 },
    });
    await attempt();

    const hook = await read();
    assert.equal(hook.isActive, false, 'kept queueing deliveries to a dead endpoint');
    assert.ok(hook.disabledAt, 'switched it off without recording that the panel did it');
    assert.ok(
      hook.disabledReason && hook.disabledReason.length > 0,
      'left the operator to guess why',
    );
  });

  it('tells the people who can do something about it', async () => {
    await app.prisma.webhook.update({
      where: { id: webhookId },
      data: { failureCount: FAILURES - 1 },
    });
    await attempt();

    const notifications = await app.prisma.notification.findMany({
      where: { userId: ownerId, type: NotificationType.SECURITY_EVENT },
    });
    assert.equal(notifications.length, 1, JSON.stringify(notifications.map((n) => n.title)));
    assert.match(notifications[0]?.title ?? '', /webhook/i);
    assert.match(notifications[0]?.message ?? '', /Billing/);
    assert.equal(notifications[0]?.link, '/admin/webhooks');
  });

  it('says it once, however many deliveries were in flight', async () => {
    // Eight of these run at once. One endpoint going down should not send the
    // owner eight notifications about it.
    await app.prisma.webhook.update({
      where: { id: webhookId },
      data: { failureCount: FAILURES - 1 },
    });
    await Promise.all([attempt(), attempt(), attempt()]);

    const notifications = await app.prisma.notification.findMany({ where: { userId: ownerId } });
    assert.equal(notifications.length, 1, `told them ${notifications.length} times`);
  });

  it('shows the operator why it is off', async () => {
    await app.prisma.webhook.update({
      where: { id: webhookId },
      data: { failureCount: FAILURES - 1 },
    });
    await attempt();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/webhooks',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(response.statusCode, 200, response.body);

    const row = response
      .json<{
        data: {
          id: string;
          isActive: boolean;
          disabledAt: string | null;
          disabledReason: string | null;
        }[];
      }>()
      .data.find((entry) => entry.id === webhookId);

    assert.equal(row?.isActive, false);
    assert.ok(row?.disabledAt, 'the page cannot tell this apart from a switch somebody flipped');
    assert.ok(row?.disabledReason);
  });

  it('starts clean when it is switched back on', async () => {
    await app.prisma.webhook.update({
      where: { id: webhookId },
      data: {
        isActive: false,
        failureCount: FAILURES,
        disabledAt: new Date(),
        disabledReason: 'getaddrinfo ENOTFOUND',
      },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/webhooks/${webhookId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { isActive: true },
    });
    assert.equal(response.statusCode, 200, response.body);

    const hook = await read();
    assert.equal(hook.isActive, true);
    assert.equal(hook.failureCount, 0, 'one more failure would switch it straight off again');
    assert.equal(hook.disabledAt, null);
    assert.equal(hook.disabledReason, null, 'still explaining a state it has left');
  });

  it('records every attempt, so the failures can be read back', async () => {
    await attempt();
    await attempt();

    const deliveries = await app.prisma.webhookDelivery.findMany({ where: { webhookId } });
    assert.equal(deliveries.length, 2);
    assert.ok(deliveries.every((delivery) => delivery.status === 'FAILED'));
    assert.ok(deliveries.every((delivery) => (delivery.error ?? '').length > 0));
  });

  it('does nothing at all for a webhook already switched off', async () => {
    await app.prisma.webhook.update({
      where: { id: webhookId },
      data: { isActive: false, failureCount: 3 },
    });
    await attempt();

    const hook = await read();
    assert.equal(hook.failureCount, 3, 'kept counting against an endpoint nobody is calling');
    assert.equal(await app.prisma.webhookDelivery.count({ where: { webhookId } }), 0);
  });
});
