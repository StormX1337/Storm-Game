import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { NodeStatus } from '@storm/types';
import { hashPassword } from '@storm/security';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Which nodes a customer may put a server on.
 *
 * A node can be marked not public — reserved capacity an operator keeps for
 * themselves — put into maintenance, or simply be offline. The deployment list
 * hides all three from a customer, and that is where it stopped: the create
 * endpoint took whatever `nodeId` it was handed.
 *
 * Hiding a node from a dropdown is not refusing to place a server on it. Anyone
 * reading their own network tab could post the id of a private node and land on
 * the operator's reserved hardware, or of a node that was down and spend their
 * quota on a server whose install would never run.
 */
describe('placing a server on a node', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let customer: RegisteredUser;
  let adminToken: string;
  let templateId: string;
  let publicNodeId: string;
  let privateNodeId: string;
  const createdUsers: string[] = [];
  const nodeIds: string[] = [];
  const createdServers: string[] = [];

  const LIMITS = {
    cpuLimit: 100,
    memoryLimit: 1024,
    diskLimit: 2048,
    swapLimit: 0,
    ioWeight: 500,
    pidsLimit: 128,
    oomKill: true,
  };

  async function makeNode(label: string, data: Record<string, unknown>): Promise<string> {
    const suffix = uniqueSuffix();
    const node = await app.prisma.node.create({
      data: {
        name: `place-${label}-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 32768,
        diskTotal: 204800,
        status: NodeStatus.ONLINE,
        isPublic: true,
        ...data,
      },
    });
    nodeIds.push(node.id);
    // Free ports, or creation fails for a reason that has nothing to do with
    // what is being tested here.
    for (let index = 0; index < 8; index += 1) {
      await app.prisma.serverAllocation.create({
        data: { nodeId: node.id, ip: '127.0.0.1', port: 41000 + Math.floor(Math.random() * 20000) },
      });
    }
    return node.id;
  }

  async function createOn(nodeId: string, token: string, ownerId?: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: `Placed ${uniqueSuffix().slice(0, 6)}`,
        nodeId,
        templateId,
        ...(ownerId ? { ownerId } : {}),
        environment: {},
        limits: LIMITS,
        skipInstall: true,
      },
    });
    if (response.statusCode === 201) {
      createdServers.push(response.json<{ data: { id: string } }>().data.id);
    }
    return response;
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    customer = await registerUser(app);
    createdUsers.push(customer.id);

    const suffix = uniqueSuffix();
    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const owner = await app.prisma.user.create({
      data: {
        email: `place-owner-${suffix}@storm.test`,
        username: `placeowner${suffix}`,
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

    templateId = (await app.prisma.gameTemplate.findFirstOrThrow({ where: { slug: 'local-test' } }))
      .id;

    publicNodeId = await makeNode('public', {});
    privateNodeId = await makeNode('private', { isPublic: false });

    // Room for the servers these tests create.
    await app.prisma.user.update({
      where: { id: customer.id },
      data: { serverLimit: 0, memoryLimit: 0, diskLimit: 0 },
    });
  });

  after(async () => {
    for (const id of createdServers) {
      await app.prisma.server.delete({ where: { id } }).catch(() => undefined);
    }
    for (const nodeId of nodeIds) {
      await app.prisma.serverAllocation.updateMany({ where: { nodeId }, data: { serverId: null } });
      await app.prisma.server.deleteMany({ where: { nodeId } });
      await app.prisma.serverAllocation.deleteMany({ where: { nodeId } });
      await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    }
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    await app.prisma.node.update({
      where: { id: publicNodeId },
      data: { isPublic: true, maintenanceMode: false, status: NodeStatus.ONLINE },
    });
    await app.prisma.node.update({
      where: { id: privateNodeId },
      data: { isPublic: false, maintenanceMode: false, status: NodeStatus.ONLINE },
    });
  });

  it('lets a customer onto a node they were actually offered', async () => {
    const response = await createOn(publicNodeId, customer.accessToken);
    assert.equal(response.statusCode, 201, response.body);
  });

  it('refuses a customer the private node the list never showed them', async () => {
    // Reserved capacity is reserved. The customer never saw this node in the
    // deployment list; posting its id was the whole exploit.
    const response = await createOn(privateNodeId, customer.accessToken);
    assert.equal(response.statusCode, 404, response.body);
    assert.match(response.body, /not found/i, 'told a stranger which private nodes exist');
  });

  it('refuses a customer a node that is not answering', async () => {
    // The install job would be queued against a machine that is down: the
    // server sits in INSTALLING forever and the quota is spent on it.
    for (const status of [NodeStatus.OFFLINE, NodeStatus.DEGRADED, NodeStatus.MAINTENANCE]) {
      await app.prisma.node.update({ where: { id: publicNodeId }, data: { status } });
      const response = await createOn(publicNodeId, customer.accessToken);
      assert.equal(response.statusCode, 404, `${status} → ${response.statusCode} ${response.body}`);
    }
  });

  it('refuses everybody a node in maintenance, admins included', async () => {
    // Maintenance is a deliberate "no new servers here", not a visibility
    // setting, so it holds for the person who set it too.
    await app.prisma.node.update({
      where: { id: publicNodeId },
      data: { maintenanceMode: true },
    });

    for (const token of [customer.accessToken, adminToken]) {
      const response = await createOn(
        publicNodeId,
        token,
        token === adminToken ? customer.id : undefined,
      );
      assert.equal(response.statusCode, 409, response.body);
      assert.match(response.body, /maintenance/i);
    }
  });

  it('lets an operator use their own reserved capacity', async () => {
    // Which is what a private node is for. The rule is about who was offered
    // the node, not about the node being unusable.
    const response = await createOn(privateNodeId, adminToken, customer.id);
    assert.equal(response.statusCode, 201, response.body);
  });

  it('offers a customer exactly the nodes it will accept', async () => {
    // The list and the boundary have to agree. When they drift, either the
    // panel offers a node that then refuses the server, or it hides one it
    // would have taken.
    await app.prisma.node.update({
      where: { id: publicNodeId },
      data: { status: NodeStatus.OFFLINE },
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/nodes',
      headers: { authorization: `Bearer ${customer.accessToken}` },
    });
    assert.equal(listed.statusCode, 200, listed.body);
    const ids = listed.json<{ data: { id: string }[] }>().data.map((node) => node.id);

    assert.ok(!ids.includes(privateNodeId), 'a private node was offered');
    assert.ok(!ids.includes(publicNodeId), 'an offline node was offered');

    for (const nodeId of [privateNodeId, publicNodeId]) {
      const response = await createOn(nodeId, customer.accessToken);
      assert.equal(response.statusCode, 404, `${nodeId} → ${response.body}`);
    }
  });
});
