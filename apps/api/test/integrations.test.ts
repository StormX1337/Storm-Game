import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '@storm/security';
import { createTestApp, registerUser, uniqueSuffix, type RegisteredUser } from './helpers.js';

/**
 * The two "prove it works" endpoints. Both reach outward, so both are places
 * where an admin session could be turned into someone else's problem: mail
 * into a relay, webhooks into a probe of the panel's own network.
 */
describe('integration tests from the admin area', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  const createdUsers: string[] = [];
  const createdWebhooks: string[] = [];

  let ownerToken: string;
  let ownerEmail: string;
  let customer: RegisteredUser;

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    customer = await registerUser(app);
    createdUsers.push(customer.id);

    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const suffix = uniqueSuffix();
    ownerEmail = `int-owner-${suffix}@storm.test`;
    const owner = await app.prisma.user.create({
      data: {
        email: ownerEmail,
        username: `intowner${suffix}`,
        passwordHash: await hashPassword('OwnerPassword123!'),
        roleId: ownerRole.id,
        emailVerifiedAt: new Date(),
      },
    });
    createdUsers.push(owner.id);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: ownerEmail, password: 'OwnerPassword123!' },
    });
    ownerToken = login.json<{ data: { accessToken: string } }>().data.accessToken;
  });

  after(async () => {
    await app.prisma.webhookDelivery.deleteMany({ where: { webhookId: { in: createdWebhooks } } });
    await app.prisma.webhook.deleteMany({ where: { id: { in: createdWebhooks } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    await cleanup();
  });

  describe('mail', () => {
    it('says SMTP is unconfigured instead of silently doing nothing', async () => {
      // The mail service logs and returns when there is no SMTP host, which is
      // right for a password reset and useless for a test — the operator has to
      // learn that nothing was sent.
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/settings/mail/test',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {},
      });

      assert.equal(response.statusCode, 400);
      assert.match(response.json<{ error: { message: string } }>().error.message, /SMTP/i);
    });

    it('is closed to a customer', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/settings/mail/test',
        headers: { authorization: `Bearer ${customer.accessToken}` },
        payload: {},
      });
      assert.equal(response.statusCode, 403);
    });

    it('takes no recipient, so it cannot be pointed at a stranger', async () => {
      // Sending only to the caller is what keeps an admin session from being a
      // relay. A `to` in the body must not change where it goes.
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/settings/mail/test',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { to: 'victim@example.com' },
      });

      // Rejected here because SMTP is unconfigured — the point is that the
      // address was never consulted.
      assert.equal(response.statusCode, 400);
      assert.doesNotMatch(response.body, /victim@example\.com/);
    });
  });

  describe('webhooks', () => {
    it('refuses a destination inside the panel network', async () => {
      const hook = await app.prisma.webhook.create({
        data: {
          name: `ssrf-${uniqueSuffix()}`,
          url: 'http://127.0.0.1:8080/api/v1/admin/users',
          secretEnc: app.encrypter.encrypt('test-secret'),
          events: ['server.created'],
        },
      });
      createdWebhooks.push(hook.id);

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/webhooks/${hook.id}/test`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {},
      });

      assert.equal(response.statusCode, 200);
      const body = response.json<{ data: { ok: boolean; error: string | null } }>();
      assert.equal(body.data.ok, false, 'a loopback destination must not be delivered to');
      assert.ok(body.data.error);
    });

    it('records the attempt in the delivery history', async () => {
      const hook = await app.prisma.webhook.create({
        data: {
          name: `history-${uniqueSuffix()}`,
          url: 'http://10.0.0.1/hook',
          secretEnc: app.encrypter.encrypt('test-secret'),
          events: ['server.created'],
        },
      });
      createdWebhooks.push(hook.id);

      await app.inject({
        method: 'POST',
        url: `/api/v1/admin/webhooks/${hook.id}/test`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {},
      });

      const deliveries = await app.prisma.webhookDelivery.findMany({
        where: { webhookId: hook.id },
      });
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]?.event, 'panel.test');
    });

    it('404s for a webhook that does not exist', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/webhooks/clnonexistent000000000000/test',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {},
      });
      assert.equal(response.statusCode, 404);
    });

    it('is closed to a customer', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/webhooks/whatever/test',
        headers: { authorization: `Bearer ${customer.accessToken}` },
        payload: {},
      });
      assert.equal(response.statusCode, 403);
    });
  });
});
