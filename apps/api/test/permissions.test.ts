import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '@storm/security';
import { createTestApp, deleteUser, registerUser, uniqueSuffix, type RegisteredUser } from './helpers.js';

/**
 * Authorisation is the part of a hosting panel where a bug is a breach, so
 * these tests assert the boundaries directly: a customer must not reach admin
 * routes, must not see another tenant's server, and must not be able to grant
 * themselves anything.
 */
describe('permissions and tenancy', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  const createdUsers: string[] = [];
  const createdServers: string[] = [];

  let customer: RegisteredUser;
  let otherCustomer: RegisteredUser;
  let adminToken: string;
  let nodeId: string;
  let templateId: string;

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    customer = await registerUser(app);
    otherCustomer = await registerUser(app);
    createdUsers.push(customer.id, otherCustomer.id);

    // A throwaway owner, so the suite never depends on the operator's account.
    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const suffix = uniqueSuffix();
    const owner = await app.prisma.user.create({
      data: {
        email: `owner-${suffix}@storm.test`,
        username: `owner${suffix}`,
        passwordHash: await hashPassword('OwnerPassword123!'),
        roleId: ownerRole.id,
        emailVerifiedAt: new Date(),
        serverLimit: 100,
      },
    });
    createdUsers.push(owner.id);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: owner.email, password: 'OwnerPassword123!' },
    });
    adminToken = login.json<{ data: { accessToken: string } }>().data.accessToken;

    // A node and template to attach test servers to.
    const node = await app.prisma.node.create({
      data: {
        name: `test-node-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 65536,
        diskTotal: 500000,
      },
    });
    nodeId = node.id;

    const template = await app.prisma.gameTemplate.findFirstOrThrow({ where: { isActive: true } });
    templateId = template.id;
  });

  after(async () => {
    for (const id of createdServers) {
      await app.prisma.serverAllocation.updateMany({
        where: { serverId: id },
        data: { serverId: null, isPrimary: false },
      });
      await app.prisma.server.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of createdUsers) await deleteUser(app, id);
    await app.prisma.serverAllocation.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    await cleanup();
  });

  async function createServerFor(ownerId: string, name: string): Promise<string> {
    const suffix = uniqueSuffix();
    const allocation = await app.prisma.serverAllocation.create({
      data: { nodeId, ip: '127.0.0.1', port: 20000 + Math.floor(Math.random() * 40000) },
    });

    const server = await app.prisma.server.create({
      data: {
        name,
        shortId: suffix.slice(0, 8),
        ownerId,
        nodeId,
        templateId,
        status: 'OFFLINE',
        dockerImage: 'storm/test-runtime:latest',
        startupCommand: 'sleep 3600',
        sftpUsername: `sftp${suffix}`,
        sftpPasswordEnc: app.encrypter.encrypt('irrelevant-for-this-test'),
        installedAt: new Date(),
        allocations: { connect: { id: allocation.id } },
      },
    });

    await app.prisma.serverAllocation.update({
      where: { id: allocation.id },
      data: { isPrimary: true },
    });

    createdServers.push(server.id);
    return server.id;
  }

  /* --------------------------------------------------------- admin routes -- */

  it('refuses admin routes to a customer', async () => {
    const routes = [
      '/api/v1/admin/users',
      '/api/v1/admin/nodes',
      '/api/v1/admin/templates',
      '/api/v1/admin/servers',
      '/api/v1/admin/audit',
      '/api/v1/admin/settings',
      '/api/v1/admin/overview',
    ];

    for (const url of routes) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${customer.accessToken}` },
      });
      assert.equal(response.statusCode, 403, `${url} must be forbidden for a customer`);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'FORBIDDEN');
    }
  });

  it('allows admin routes to an owner', async () => {
    for (const url of ['/api/v1/admin/users', '/api/v1/admin/nodes', '/api/v1/admin/overview']) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      assert.equal(response.statusCode, 200, url);
    }
  });

  /* ------------------------------------------------------------- tenancy -- */

  it('hides another tenant’s server behind a 404, not a 403', async () => {
    const serverId = await createServerFor(otherCustomer.id, 'Someone else’s server');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
    });

    // 403 would confirm the id exists, which is an enumeration oracle.
    assert.equal(response.statusCode, 404);
    assert.equal(response.json<{ error: { code: string } }>().error.code, 'SERVER_NOT_FOUND');
  });

  it('excludes other tenants from the server list', async () => {
    await createServerFor(otherCustomer.id, 'Hidden server');
    const mine = await createServerFor(customer.id, 'My server');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${customer.accessToken}` },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json<{ data: { id: string }[] }>();
    const ids = body.data.map((server) => server.id);
    assert.ok(ids.includes(mine));
    assert.equal(
      body.data.every((server) => server.id !== undefined),
      true,
    );
    // Every returned server must belong to the caller.
    const owners = await app.prisma.server.findMany({
      where: { id: { in: ids } },
      select: { ownerId: true },
    });
    assert.ok(owners.every((server) => server.ownerId === customer.id));
  });

  it('refuses power actions on another tenant’s server', async () => {
    const serverId = await createServerFor(otherCustomer.id, 'Not yours');

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/power`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
      payload: { action: 'start' },
    });
    assert.equal(response.statusCode, 404);
  });

  it('refuses file access on another tenant’s server', async () => {
    const serverId = await createServerFor(otherCustomer.id, 'Private files');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/files/list?path=/`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
    });
    assert.equal(response.statusCode, 404);
  });

  it('refuses backups and databases on another tenant’s server', async () => {
    const serverId = await createServerFor(otherCustomer.id, 'Private data');

    for (const url of [
      `/api/v1/servers/${serverId}/backups`,
      `/api/v1/servers/${serverId}/databases`,
      `/api/v1/servers/${serverId}/schedules`,
    ]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${customer.accessToken}` },
      });
      assert.equal(response.statusCode, 404, url);
    }
  });

  /* ------------------------------------------------------- sub-user grants -- */

  it('gives a sub-user exactly the permissions they were granted', async () => {
    const serverId = await createServerFor(customer.id, 'Shared server');

    const share = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/subusers`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
      payload: { email: otherCustomer.email, permissions: ['servers.view', 'servers.console'] },
    });
    assert.equal(share.statusCode, 200);

    // Granted: they can see it.
    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}`,
      headers: { authorization: `Bearer ${otherCustomer.accessToken}` },
    });
    assert.equal(view.statusCode, 200);

    // Not granted: starting it is refused.
    const start = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/power`,
      headers: { authorization: `Bearer ${otherCustomer.accessToken}` },
      payload: { action: 'start' },
    });
    assert.equal(start.statusCode, 403);

    // Not granted: deleting it is refused.
    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${serverId}`,
      headers: { authorization: `Bearer ${otherCustomer.accessToken}` },
      payload: {},
    });
    assert.equal(remove.statusCode, 403);
  });

  it('does not let a sub-user grant permissions the sharer lacks', async () => {
    const serverId = await createServerFor(customer.id, 'Escalation attempt');

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/subusers`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
      payload: { email: otherCustomer.email, permissions: ['admin.servers', 'users.manage'] },
    });

    // None of those are grantable, so the request is refused outright.
    assert.equal(response.statusCode, 403);
  });

  /* ------------------------------------------------------ self-escalation -- */

  it('does not let a customer create a server for someone else', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${customer.accessToken}` },
      payload: {
        name: 'Server for another user',
        nodeId,
        templateId,
        ownerId: otherCustomer.id,
        environment: {},
        limits: {
          cpuLimit: 100,
          memoryLimit: 512,
          diskLimit: 1024,
          swapLimit: 0,
          ioWeight: 500,
          networkLimitMbps: 0,
          pidsLimit: 128,
          oomKill: true,
        },
      },
    });
    assert.equal(response.statusCode, 403);
  });

  it('ignores role and limit fields submitted to the profile endpoint', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/account',
      headers: { authorization: `Bearer ${customer.accessToken}` },
      payload: { firstName: 'Legit', role: 'OWNER', serverLimit: 9999, extraPermissions: ['admin.servers'] },
    });
    assert.equal(response.statusCode, 200);

    const after = await app.prisma.user.findUniqueOrThrow({
      where: { id: customer.id },
      include: { role: true },
    });
    assert.equal(after.role.name, 'CUSTOMER', 'role must not be self-assignable');
    assert.equal(after.extraPermissions.length, 0, 'permissions must not be self-assignable');
    assert.equal(after.firstName, 'Legit', 'the legitimate field should still apply');
  });

  it('caps an API key to the permissions its owner holds', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/account/api-keys',
      headers: { authorization: `Bearer ${customer.accessToken}` },
      payload: { name: 'Escalating key', permissions: ['admin.servers', 'users.manage'] },
    });

    assert.equal(response.statusCode, 403, 'a key must not grant more than its owner has');
  });

  it('refuses to let an admin be deleted by a customer', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/users/${customer.id}`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
    });
    assert.equal(response.statusCode, 403);
  });

  /* ------------------------------------------------------- input validation -- */

  it('rejects a path traversal attempt in the file API', async () => {
    const serverId = await createServerFor(customer.id, 'Traversal target');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/files/contents?path=${encodeURIComponent('../../../../etc/passwd')}`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
    });

    // The node is unreachable in this suite, so the interesting assertion is
    // that it never returns file content.
    assert.notEqual(response.statusCode, 200);
    assert.ok(!response.body.includes('root:'), 'must never return host file contents');
  });

  it('rejects an unknown power action', async () => {
    const serverId = await createServerFor(customer.id, 'Bad action');

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/power`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
      payload: { action: 'rm -rf /' },
    });
    assert.equal(response.statusCode, 400);
  });
});
