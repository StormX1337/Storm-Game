import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '@storm/security';
import { createTestApp, registerUser, uniqueSuffix, type RegisteredUser } from './helpers.js';

/**
 * The update endpoints are the most dangerous surface in the panel: one of them
 * asks the host to replace the running code. These check that it is reachable
 * only by an account that holds the permission, and that it will only ever ask
 * for the exact version the panel itself just offered.
 */
describe('panel updates', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  const createdUsers: string[] = [];

  let ownerToken: string;
  let customer: RegisteredUser;

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    customer = await registerUser(app);
    createdUsers.push(customer.id);

    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const suffix = uniqueSuffix();
    const owner = await app.prisma.user.create({
      data: {
        email: `upd-owner-${suffix}@storm.test`,
        username: `updowner${suffix}`,
        passwordHash: await hashPassword('OwnerPassword123!'),
        roleId: ownerRole.id,
        emailVerifiedAt: new Date(),
      },
    });
    createdUsers.push(owner.id);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: owner.email, password: 'OwnerPassword123!' },
    });
    ownerToken = login.json<{ data: { accessToken: string } }>().data.accessToken;
  });

  after(async () => {
    await app.prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    await cleanup();
  });

  it('reports the running version to an owner', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/updates',
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json<{
      data: { current: { version: string; commit: string }; canApply: boolean };
    }>();
    assert.ok(body.data.current.version.length > 0);
    assert.ok(body.data.current.commit.length > 0);
  });

  it('keeps a customer out of the update surface entirely', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/admin/updates'],
      ['POST', '/api/v1/admin/updates/apply'],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${customer.accessToken}` },
        ...(method === 'POST' ? { payload: { commit: 'abcdef1234567890' } } : {}),
      });
      assert.equal(response.statusCode, 403, `${method} ${url} should be forbidden`);
    }
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/updates' });
    assert.equal(response.statusCode, 401);
  });

  it('refuses to apply a commit the panel did not offer', async () => {
    // Without this the endpoint reads "run any commit this repository ever
    // held", which is a very different thing from "apply the update shown".
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/updates/apply',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    });

    assert.equal(response.statusCode, 400);
    assert.match(
      response.json<{ error: { message: string } }>().error.message,
      /no longer the latest|cannot apply/i,
    );
  });

  it('rejects a malformed commit before it reaches anything', async () => {
    for (const commit of ['../../etc/passwd', 'abc; rm -rf /', 'not-hex-at-all!!']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/updates/apply',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { commit },
      });
      assert.ok(response.statusCode >= 400, `"${commit}" should be rejected`);
    }
  });

  it('says why it cannot apply, rather than pretending it can', async () => {
    // No updater is connected in a test environment, and the panel has to be
    // honest about that instead of offering a button that does nothing.
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/updates',
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    const body = response.json<{ data: { canApply: boolean; reason: string | null } }>();
    assert.equal(body.data.canApply, false);
    assert.ok(body.data.reason && body.data.reason.length > 0);
  });
});
