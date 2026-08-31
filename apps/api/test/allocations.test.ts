import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { generateToken } from '@storm/security';
import { createTestApp, registerUser, uniqueSuffix, type RegisteredUser } from './helpers.js';

/**
 * Ports are the one resource two tenants can collide over: a node has a finite
 * range, servers claim from it, and a claim on someone else's port takes their
 * server off the network. So a customer may only ever claim a port that is free
 * and on their own server's node, and may only release one their server holds.
 */
describe('claiming ports', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let mine: RegisteredUser;
  let theirs: RegisteredUser;

  const created: { users: string[]; nodes: string[]; servers: string[] } = {
    users: [],
    nodes: [],
    servers: [],
  };

  let myNode: string;
  let otherNode: string;
  let myServer: { id: string; shortId: string };
  let theirServer: { id: string; shortId: string };

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    mine = await registerUser(app);
    theirs = await registerUser(app);
    created.users.push(mine.id, theirs.id);

    myNode = (await makeNode()).id;
    otherNode = (await makeNode()).id;
    myServer = await makeServer(mine.id, myNode);
    theirServer = await makeServer(theirs.id, myNode);
  });

  after(async () => {
    await app.prisma.serverAllocation.deleteMany({ where: { nodeId: { in: created.nodes } } });
    await app.prisma.server.deleteMany({ where: { id: { in: created.servers } } });
    await app.prisma.node.deleteMany({ where: { id: { in: created.nodes } } });
    await app.prisma.user.deleteMany({ where: { id: { in: created.users } } });
    await cleanup();
  });

  async function makeNode() {
    const node = await app.prisma.node.create({
      data: {
        name: `alloc-node-${uniqueSuffix()}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        agentPort: 8081,
        sftpPort: 2022,
        cpuCores: 4,
        memoryTotal: 8192,
        diskTotal: 40960,
      },
    });
    created.nodes.push(node.id);
    return node;
  }

  async function makeServer(ownerId: string, nodeId: string) {
    const suffix = uniqueSuffix();
    const template = await app.prisma.gameTemplate.findFirstOrThrow();
    const server = await app.prisma.server.create({
      data: {
        name: `Server ${suffix}`,
        shortId: `a${suffix}`.slice(0, 12),
        ownerId,
        nodeId,
        templateId: template.id,
        dockerImage: 'eclipse-temurin:25-jre',
        startupCommand: 'true',
        memoryLimit: 1024,
        diskLimit: 1024,
        cpuLimit: 100,
        status: 'OFFLINE',
        sftpUsername: `alloc${suffix}`,
        sftpPasswordEnc: app.encrypter.encrypt(generateToken(8)),
      },
    });
    created.servers.push(server.id);
    return { id: server.id, shortId: server.shortId };
  }

  async function makeAllocation(nodeId: string, port: number, serverId?: string) {
    return app.prisma.serverAllocation.create({
      data: { nodeId, ip: '127.0.0.1', port, serverId: serverId ?? null },
    });
  }

  function claim(as: RegisteredUser, server: string, allocationId?: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/servers/${server}/allocations`,
      headers: { authorization: `Bearer ${as.accessToken}` },
      payload: allocationId ? { allocationId } : {},
    });
  }

  it('refuses a port that belongs to another tenant’s server', async () => {
    const taken = await makeAllocation(myNode, 40001, theirServer.id);

    const response = await claim(mine, myServer.shortId, taken.id);
    assert.equal(response.statusCode, 409, response.body);

    // And it is still theirs afterwards.
    const after = await app.prisma.serverAllocation.findUniqueOrThrow({ where: { id: taken.id } });
    assert.equal(after.serverId, theirServer.id);
  });

  it('refuses a free port on a node the server is not on', async () => {
    const elsewhere = await makeAllocation(otherNode, 40002);

    const response = await claim(mine, myServer.shortId, elsewhere.id);
    assert.equal(response.statusCode, 409, response.body);

    const after = await app.prisma.serverAllocation.findUniqueOrThrow({
      where: { id: elsewhere.id },
    });
    assert.equal(after.serverId, null);
  });

  it('gives a free port to exactly one of two servers racing for it', async () => {
    const contested = await makeAllocation(myNode, 40003);

    // Both tenants ask for the same allocation at the same moment.
    const [a, b] = await Promise.all([
      claim(mine, myServer.shortId, contested.id),
      claim(theirs, theirServer.shortId, contested.id),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(codes, [200, 409], `${a.statusCode}/${b.statusCode}: ${a.body} ${b.body}`);

    const after = await app.prisma.serverAllocation.findUniqueOrThrow({
      where: { id: contested.id },
    });
    assert.ok(
      after.serverId === myServer.id || after.serverId === theirServer.id,
      'the port ended up on neither server',
    );
  });

  it('refuses to release a port held by another tenant’s server', async () => {
    const held = await makeAllocation(myNode, 40004, theirServer.id);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${myServer.shortId}/allocations/${held.id}`,
      headers: { authorization: `Bearer ${mine.accessToken}` },
    });
    assert.equal(response.statusCode, 404, response.body);

    const after = await app.prisma.serverAllocation.findUniqueOrThrow({ where: { id: held.id } });
    assert.equal(after.serverId, theirServer.id);
  });

  it('refuses to make another tenant’s port primary', async () => {
    const held = await makeAllocation(myNode, 40005, theirServer.id);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${myServer.shortId}/allocations/${held.id}/primary`,
      headers: { authorization: `Bearer ${mine.accessToken}` },
    });
    assert.equal(response.statusCode, 404, response.body);

    const after = await app.prisma.serverAllocation.findUniqueOrThrow({ where: { id: held.id } });
    assert.equal(after.isPrimary, false);
  });

  it('will not strand a server by removing its primary port', async () => {
    const primary = await app.prisma.serverAllocation.create({
      data: {
        nodeId: myNode,
        ip: '127.0.0.1',
        port: 40006,
        serverId: myServer.id,
        isPrimary: true,
      },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${myServer.shortId}/allocations/${primary.id}`,
      headers: { authorization: `Bearer ${mine.accessToken}` },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /primary port cannot be removed/i);
  });

  it('says no free port rather than reaching onto another node', async () => {
    // A node with nothing free, while the other node has ports going spare.
    const bare = await makeNode();
    const server = await makeServer(mine.id, bare.id);
    await makeAllocation(otherNode, 40007);

    const response = await claim(mine, server.shortId);
    assert.equal(response.statusCode, 409, response.body);
    assert.match(response.body, /No free port/i);
  });
});
