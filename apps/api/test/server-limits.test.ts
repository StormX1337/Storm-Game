import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '@storm/security';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Changing an existing server's resource limits.
 *
 * The reason this matters: a server killed for running out of memory needs a
 * bigger limit, and the alternative to changing one is deleting the server and
 * rebuilding it. But the same request is a way to hand yourself the node's
 * whole memory, so who may send it, and how much they may ask for, are the
 * parts worth pinning down.
 */
describe('server resource limits', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let customer: RegisteredUser;
  let adminToken: string;
  let nodeId: string;
  let serverId: string;
  const createdUsers: string[] = [];

  const limits = {
    cpuLimit: 100,
    memoryLimit: 1024,
    diskLimit: 2048,
    swapLimit: 0,
    ioWeight: 500,
    networkLimitMbps: 0,
    pidsLimit: 128,
    oomKill: true,
  };

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
        email: `limits-owner-${suffix}@storm.test`,
        username: `limitsowner${suffix}`,
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
    adminToken = login.json<{ data: { accessToken: string } }>().data.accessToken;

    // A small node, so "more than the node has" is a number a test can name.
    const node = await app.prisma.node.create({
      data: {
        name: `limits-node-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 4096,
        diskTotal: 20480,
      },
    });
    nodeId = node.id;
    await app.prisma.serverAllocation.create({ data: { nodeId, ip: '127.0.0.1', port: 26611 } });

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Limits server',
        nodeId,
        templateId: template.id,
        ownerId: customer.id,
        environment: {},
        limits,
        skipInstall: true,
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    serverId = created.json<{ data: { id: string } }>().data.id;
  });

  after(async () => {
    await app.prisma.serverAllocation.updateMany({ where: { nodeId }, data: { serverId: null } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.serverAllocation.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  it('raises the memory of a server the host has been killing', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { limits: { memoryLimit: 2048 } },
    });
    assert.equal(response.statusCode, 200, response.body);

    const server = await app.prisma.server.findUniqueOrThrow({ where: { id: serverId } });
    assert.equal(server.memoryLimit, 2048);
    // Only what was sent changes — a partial patch must not quietly reset the
    // limits it did not mention back to a default.
    assert.equal(server.diskLimit, limits.diskLimit, 'disk was not part of the request');
    assert.equal(server.cpuLimit, limits.cpuLimit, 'cpu was not part of the request');
  });

  it('refuses to give a server more memory than the node has', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { limits: { memoryLimit: 64 * 1024 } },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(
      response.json<{ error: { code: string } }>().error.code,
      'INSUFFICIENT_NODE_CAPACITY',
    );

    const server = await app.prisma.server.findUniqueOrThrow({ where: { id: serverId } });
    assert.equal(server.memoryLimit, 2048, 'a refused request must not have changed anything');
  });

  it('counts the server against the node without double-counting itself', async () => {
    // The node has 4096 MiB and this server already holds 2048 of it. Asking
    // for 4096 is fine only if the check excludes the server's own current
    // allocation — otherwise raising a limit is impossible past half a node.
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { limits: { memoryLimit: 4096 } },
    });
    assert.equal(response.statusCode, 200, response.body);

    const server = await app.prisma.server.findUniqueOrThrow({ where: { id: serverId } });
    assert.equal(server.memoryLimit, 4096);

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { limits: { memoryLimit: 2048 } },
    });
  });

  it('never lets a server owner raise their own limits', async () => {
    // The whole point of a limit is that the person it constrains cannot move
    // it. The owner may rename their server, so this has to fail on the limits
    // specifically rather than on the endpoint.
    const raise = await app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
      payload: { limits: { memoryLimit: 8192 } },
    });
    assert.equal(raise.statusCode, 403);

    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
      payload: { name: 'Renamed by its owner' },
    });
    assert.equal(rename.statusCode, 200, 'the owner still owns the rest of the server');

    const server = await app.prisma.server.findUniqueOrThrow({ where: { id: serverId } });
    assert.equal(server.memoryLimit, 2048, 'the owner must not have moved their own ceiling');
  });

  it('refuses limits below what a container can actually run on', async () => {
    for (const bad of [
      { memoryLimit: 0 },
      { memoryLimit: -1 },
      { diskLimit: 0 },
      { cpuLimit: -100 },
      { pidsLimit: 1 },
    ]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/servers/${serverId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { limits: bad },
      });
      assert.equal(response.statusCode, 400, `${JSON.stringify(bad)} must be rejected`);
    }
  });
});
