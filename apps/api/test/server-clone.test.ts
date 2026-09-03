import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { NodeStatus, ServerStatus } from '@storm/types';
import { hashPassword } from '@storm/security';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Another server like this one.
 *
 * A host setting up the fourth server for the same customer was filling in the
 * same eleven fields a fourth time — template, image, startup line, every
 * variable, every limit — and getting one of them subtly wrong on the fourth
 * go. Everything that decides what a server *is* can be read off the one being
 * copied; only the name and where it goes cannot.
 *
 * A clone is a read of one server and a write of another, so it has to answer
 * to both: whoever asks needs to be allowed to see the original and allowed to
 * create servers, and everything creation normally enforces — quotas, node
 * capacity, which nodes they may use — still holds.
 */
describe('cloning a server', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let customer: RegisteredUser;
  let stranger: RegisteredUser;
  let adminToken: string;
  let sourceId: string;
  let sourceShortId: string;
  let nodeId: string;
  let otherNodeId: string;
  let privateNodeId: string;
  let templateId: string;
  const createdUsers: string[] = [];
  const nodeIds: string[] = [];

  const LIMITS = {
    cpuLimit: 150,
    memoryLimit: 1536,
    diskLimit: 4096,
    swapLimit: 0,
    ioWeight: 400,
    pidsLimit: 256,
    oomKill: false,
  };

  async function makeNode(label: string, data: Record<string, unknown> = {}): Promise<string> {
    const suffix = uniqueSuffix();
    const node = await app.prisma.node.create({
      data: {
        name: `clone-${label}-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 32768,
        diskTotal: 204800,
        status: NodeStatus.ONLINE,
        ...data,
      },
    });
    nodeIds.push(node.id);
    for (let index = 0; index < 6; index += 1) {
      await app.prisma.serverAllocation.create({
        data: { nodeId: node.id, ip: '127.0.0.1', port: 43000 + Math.floor(Math.random() * 15000) },
      });
    }
    return node.id;
  }

  async function clone(payload: Record<string, unknown>, token = customer.accessToken) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/servers/${sourceShortId}/clone`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    customer = await registerUser(app);
    stranger = await registerUser(app);
    createdUsers.push(customer.id, stranger.id);

    const suffix = uniqueSuffix();
    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const owner = await app.prisma.user.create({
      data: {
        email: `clone-owner-${suffix}@storm.test`,
        username: `cloneowner${suffix}`,
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

    nodeId = await makeNode('home');
    otherNodeId = await makeNode('other');
    privateNodeId = await makeNode('private', { isPublic: false });

    // A template with variables of its own, since carrying those across is
    // half the point of a clone.
    templateId = (
      await app.prisma.gameTemplate.findFirstOrThrow({ where: { slug: 'minecraft-java' } })
    ).id;

    // Room to clone, then narrowed per test where the quota is the point.
    await app.prisma.user.update({
      where: { id: customer.id },
      data: { serverLimit: 0, memoryLimit: 0, diskLimit: 0, cpuLimit: 0 },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'The original',
        description: 'Set up carefully, once',
        ownerId: customer.id,
        nodeId,
        templateId,
        environment: { MAX_PLAYERS: '64', PROJECT: 'purpur', MINECRAFT_VERSION: '1.21.4' },
        limits: LIMITS,
        skipInstall: true,
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const summary = created.json<{ data: { id: string; shortId: string } }>().data;
    sourceId = summary.id;
    sourceShortId = summary.shortId;

    // A startup line and image somebody changed after creation: the clone has
    // to copy the server as it is now, not the template it came from.
    await app.prisma.server.update({
      where: { id: sourceId },
      data: { startupCommand: './run --tuned' },
    });
  });

  after(async () => {
    for (const id of nodeIds) {
      await app.prisma.serverAllocation.updateMany({
        where: { nodeId: id },
        data: { serverId: null },
      });
      await app.prisma.server.deleteMany({ where: { nodeId: id } });
      await app.prisma.serverAllocation.deleteMany({ where: { nodeId: id } });
      await app.prisma.node.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    // Everything but the original, so each test starts from one server.
    for (const id of nodeIds) {
      await app.prisma.serverAllocation.updateMany({
        where: { nodeId: id, serverId: { not: sourceId } },
        data: { serverId: null, isPrimary: false },
      });
      await app.prisma.server.deleteMany({ where: { nodeId: id, id: { not: sourceId } } });
    }
    await app.prisma.user.update({
      where: { id: customer.id },
      data: { serverLimit: 0, memoryLimit: 0, diskLimit: 0, cpuLimit: 0 },
    });
  });

  it('copies what makes the server what it is', async () => {
    const response = await clone({ name: 'The copy' });
    assert.equal(response.statusCode, 201, response.body);

    const copyId = response.json<{ data: { id: string } }>().data.id;
    const [copy, source] = await Promise.all([
      app.prisma.server.findUniqueOrThrow({ where: { id: copyId }, include: { variables: true } }),
      app.prisma.server.findUniqueOrThrow({ where: { id: sourceId } }),
    ]);

    assert.equal(copy.templateId, templateId);
    assert.equal(copy.dockerImage, source.dockerImage);
    assert.equal(copy.startupCommand, './run --tuned', 'took the template default, not the server');
    assert.equal(copy.cpuLimit, LIMITS.cpuLimit);
    assert.equal(copy.memoryLimit, LIMITS.memoryLimit);
    assert.equal(copy.diskLimit, LIMITS.diskLimit);
    assert.equal(copy.pidsLimit, LIMITS.pidsLimit);
    assert.equal(copy.oomKill, LIMITS.oomKill);

    // The values somebody set on this server, not the template's defaults.
    const values = Object.fromEntries(copy.variables.map((v) => [v.key, v.value]));
    assert.equal(values.MAX_PLAYERS, '64', 'the variables somebody tuned were not carried');
    assert.equal(values.PROJECT, 'purpur');
    assert.equal(values.MINECRAFT_VERSION, '1.21.4');
  });

  it('falls back when the original runs an image the template dropped', async () => {
    // An administrator tidying a template's image list does not make the
    // servers already running the old one uncopyable — and the copy has to
    // land on something the template actually offers.
    await app.prisma.server.update({
      where: { id: sourceId },
      data: { dockerImage: 'ghcr.io/example/retired:1' },
    });
    try {
      const response = await clone({ name: 'After the tidy-up' });
      assert.equal(response.statusCode, 201, response.body);

      const copyId = response.json<{ data: { id: string } }>().data.id;
      const [copy, template] = await Promise.all([
        app.prisma.server.findUniqueOrThrow({ where: { id: copyId } }),
        app.prisma.gameTemplate.findUniqueOrThrow({ where: { id: templateId } }),
      ]);
      assert.equal(copy.dockerImage, template.defaultImage);
    } finally {
      const template = await app.prisma.gameTemplate.findUniqueOrThrow({
        where: { id: templateId },
      });
      await app.prisma.server.update({
        where: { id: sourceId },
        data: { dockerImage: template.defaultImage },
      });
    }
  });

  it('is a new server, not a second name for the old one', async () => {
    const response = await clone({ name: 'The copy' });
    const copyId = response.json<{ data: { id: string } }>().data.id;

    const [source, copy] = await Promise.all([
      app.prisma.server.findUniqueOrThrow({ where: { id: sourceId } }),
      app.prisma.server.findUniqueOrThrow({
        where: { id: copyId },
        include: { allocations: true },
      }),
    ]);

    assert.notEqual(copy.id, source.id);
    assert.notEqual(copy.shortId, source.shortId);
    assert.notEqual(copy.uuid, source.uuid);
    // Its own SFTP account and its own password, or one customer's credentials
    // would open the other's files.
    assert.notEqual(copy.sftpUsername, source.sftpUsername);
    assert.notEqual(copy.sftpPasswordEnc, source.sftpPasswordEnc);
    assert.equal(copy.name, 'The copy');

    // A port of its own, and not the one the original is answering on.
    assert.ok(copy.allocations.length > 0, 'the copy has nowhere to listen');
    const sourcePorts = await app.prisma.serverAllocation.findMany({
      where: { serverId: source.id },
    });
    for (const allocation of copy.allocations) {
      assert.ok(
        !sourcePorts.some((port) => port.id === allocation.id),
        'the copy took the original off the air',
      );
    }
  });

  it('installs the copy rather than pretending it is ready', async () => {
    const response = await clone({ name: 'The copy' });
    const copyId = response.json<{ data: { id: string } }>().data.id;
    const copy = await app.prisma.server.findUniqueOrThrow({ where: { id: copyId } });

    // Nothing has run the install script on the new node yet, and a server
    // that says OFFLINE with an empty directory is one nobody can start.
    assert.equal(copy.status, ServerStatus.INSTALLING);
  });

  it('puts the copy where it is told, and on the source’s node otherwise', async () => {
    const here = await clone({ name: 'Same node' });
    assert.equal(here.statusCode, 201, here.body);
    const hereId = here.json<{ data: { id: string } }>().data.id;
    assert.equal(
      (await app.prisma.server.findUniqueOrThrow({ where: { id: hereId } })).nodeId,
      nodeId,
    );

    const there = await clone({ name: 'Other node', nodeId: otherNodeId });
    assert.equal(there.statusCode, 201, there.body);
    const thereId = there.json<{ data: { id: string } }>().data.id;
    assert.equal(
      (await app.prisma.server.findUniqueOrThrow({ where: { id: thereId } })).nodeId,
      otherNodeId,
    );
  });

  it('still counts against the quota the customer was sold', async () => {
    // The shortest way to give somebody twenty servers would be to clone one
    // twenty times, if this did not go through the same door as creation.
    await app.prisma.user.update({ where: { id: customer.id }, data: { serverLimit: 1 } });

    const response = await clone({ name: 'One too many' });
    assert.equal(response.statusCode, 409, response.body);
    assert.match(response.body, /at most 1 server/i);
  });

  it('still refuses a node the customer was never offered', async () => {
    const response = await clone({ name: 'Onto the private one', nodeId: privateNodeId });
    assert.equal(response.statusCode, 404, response.body);
  });

  it('refuses somebody who cannot see the original', async () => {
    const response = await clone({ name: 'Not yours' }, stranger.accessToken);
    assert.equal(response.statusCode, 404, response.body);
  });

  it('will not hand somebody else’s account a server', async () => {
    const response = await clone({ name: 'For someone else', ownerId: stranger.id });
    assert.equal(response.statusCode, 403, response.body);
  });

  it('will not let a team member spend the owner’s quota', async () => {
    // A subuser can see this server and holds servers.create on their own
    // account, which is not the same as permission to add a server to
    // somebody else's. Without a check on where the copy lands, they would be
    // spending the owner's quota on a server the owner never asked for.
    const subuser = await app.prisma.serverSubuser.create({
      data: {
        serverId: sourceId,
        userId: stranger.id,
        permissions: ['servers.view'],
      },
    });
    try {
      const response = await clone({ name: 'On the owner’s tab' }, stranger.accessToken);
      assert.equal(response.statusCode, 403, response.body);
    } finally {
      await app.prisma.serverSubuser.delete({ where: { id: subuser.id } });
    }
  });

  it('lets an operator clone one customer’s server onto another account', async () => {
    // Which is the case the restriction above exists to allow: staff moving a
    // known-good setup to a new customer.
    const response = await clone({ name: 'Provisioned', ownerId: stranger.id }, adminToken);
    assert.equal(response.statusCode, 201, response.body);

    const copyId = response.json<{ data: { id: string } }>().data.id;
    const copy = await app.prisma.server.findUniqueOrThrow({ where: { id: copyId } });
    assert.equal(copy.ownerId, stranger.id);
    assert.equal(copy.startupCommand, './run --tuned');
  });

  it('refuses a suspended source rather than copying a suspension', async () => {
    await app.prisma.server.update({
      where: { id: sourceId },
      data: { suspendedAt: new Date(), status: ServerStatus.SUSPENDED },
    });
    try {
      const response = await clone({ name: 'From a suspended one' });
      assert.equal(response.statusCode, 403, response.body);
    } finally {
      await app.prisma.server.update({
        where: { id: sourceId },
        data: { suspendedAt: null, status: ServerStatus.OFFLINE },
      });
    }
  });
});
