import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '@storm/security';
import {
  claimPanelStorage,
  createTestApp,
  deleteUser,
  registerUser,
  uniqueSuffix,
} from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Moving a server to another node.
 *
 * The move itself takes hours and runs on a queue; what this suite pins down is
 * the preflight, because that is the part that decides whether an operator
 * finds out now or an hour in, with a customer's world already archived.
 */
describe('moving a server between nodes', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  /** Given back in `after`; see claimPanelStorage. */
  let releaseStorage: () => Promise<void>;
  let customer: RegisteredUser;
  let adminToken: string;
  let sourceNodeId: string;
  let destNodeId: string;
  let serverId: string;
  let sharedStorageId: string;
  const createdUsers: string[] = [];
  const nodeIds: string[] = [];

  const admin = () => ({ authorization: `Bearer ${adminToken}` });
  const move = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/admin/servers/${serverId}/move`,
      headers: admin(),
      payload,
    });

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;
    // The panel has one storage configuration and this suite depends on
    // what it says, so it waits for its turn at it.
    releaseStorage = await claimPanelStorage(app);

    customer = await registerUser(app);
    createdUsers.push(customer.id);

    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const suffix = uniqueSuffix();
    const owner = await app.prisma.user.create({
      data: {
        email: `move-owner-${suffix}@storm.test`,
        username: `moveowner${suffix}`,
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

    const makeNode = async (label: string, memory = 8192, disk = 51200) => {
      const node = await app.prisma.node.create({
        data: {
          name: `move-${label}-${suffix}`,
          location: 'Test',
          hostname: '127.0.0.1',
          ip: '127.0.0.1',
          scheme: 'http',
          memoryTotal: memory,
          diskTotal: disk,
          status: 'ONLINE',
        },
      });
      nodeIds.push(node.id);
      return node.id;
    };

    sourceNodeId = await makeNode('source');
    destNodeId = await makeNode('dest');
    await app.prisma.serverAllocation.create({
      data: { nodeId: sourceNodeId, ip: '127.0.0.1', port: 26811 },
    });
    await app.prisma.serverAllocation.create({
      data: { nodeId: destNodeId, ip: '127.0.0.1', port: 26812 },
    });

    // The route between two hosts is object storage, so a shared one has to
    // exist for any of this to be possible at all.
    const storage = await app.prisma.backupStorage.create({
      data: {
        name: `move-storage-${suffix}`,
        driver: 'S3',
        bucket: 'storm-test',
        region: 'auto',
        isActive: true,
      },
    });
    sharedStorageId = storage.id;

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: admin(),
      payload: {
        name: 'Server on the move',
        nodeId: sourceNodeId,
        templateId: template.id,
        ownerId: customer.id,
        environment: {},
        limits: {
          cpuLimit: 100,
          memoryLimit: 1024,
          diskLimit: 2048,
          swapLimit: 0,
          ioWeight: 500,
          pidsLimit: 128,
          oomKill: true,
        },
        skipInstall: true,
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    serverId = created.json<{ data: { id: string } }>().data.id;
  });

  beforeEach(async () => {
    await app.prisma.server.update({
      where: { id: serverId },
      data: { status: 'OFFLINE', nodeId: sourceNodeId },
    });
    await app.prisma.node.update({
      where: { id: destNodeId },
      data: { status: 'ONLINE', maintenanceMode: false, memoryTotal: 8192, diskTotal: 51200 },
    });
    await app.prisma.backupStorage.update({
      where: { id: sharedStorageId },
      data: { isActive: true, driver: 'S3' },
    });
  });

  after(async () => {
    for (const nodeId of nodeIds) {
      await app.prisma.serverAllocation.updateMany({ where: { nodeId }, data: { serverId: null } });
      await app.prisma.server.deleteMany({ where: { nodeId } });
      await app.prisma.serverAllocation.deleteMany({ where: { nodeId } });
      await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    }
    await app.prisma.backupStorage
      .delete({ where: { id: sharedStorageId } })
      .catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await releaseStorage();
    await cleanup();
  });

  it('queues the move and says what is about to happen', async () => {
    const response = await move({ nodeId: destNodeId });
    assert.equal(response.statusCode, 200, response.body);

    const data = response.json<{ data: { queued: boolean; from: string; to: string } }>().data;
    assert.equal(data.queued, true);
    assert.match(data.from, /move-source/);
    assert.match(data.to, /move-dest/);

    // Queued, not done: the server has not gone anywhere yet.
    const server = await app.prisma.server.findUniqueOrThrow({ where: { id: serverId } });
    assert.equal(server.nodeId, sourceNodeId, 'the row must not move before the files do');
  });

  it('refuses a move to the node it is already on', async () => {
    const response = await move({ nodeId: sourceNodeId });
    assert.equal(response.statusCode, 400);
  });

  it('refuses a destination that is not taking servers', async () => {
    await app.prisma.node.update({
      where: { id: destNodeId },
      data: { maintenanceMode: true },
    });
    const maintenance = await move({ nodeId: destNodeId });
    assert.equal(maintenance.statusCode, 409, maintenance.body);

    await app.prisma.node.update({
      where: { id: destNodeId },
      data: { maintenanceMode: false, status: 'OFFLINE' },
    });
    const offline = await move({ nodeId: destNodeId });
    assert.equal(offline.statusCode, 409, 'an unreachable node cannot receive a server');
  });

  it('refuses when the destination has no room', async () => {
    await app.prisma.node.update({
      where: { id: destNodeId },
      data: { memoryTotal: 256, diskTotal: 512 },
    });
    const response = await move({ nodeId: destNodeId });

    assert.equal(response.statusCode, 409);
    assert.equal(
      response.json<{ error: { code: string } }>().error.code,
      'INSUFFICIENT_NODE_CAPACITY',
    );
  });

  it('accepts the move without shared storage, and refuses it with none at all', async () => {
    // The first half used to be a refusal. Shared storage is the good route —
    // the archive goes node to bucket to node and nothing large touches the
    // panel — but demanding it meant running S3 to shift a server between two
    // machines an operator already owns. Without a bucket the panel streams
    // the archive itself, so all the move really needs is somewhere to record
    // it against.
    await app.prisma.backupStorage.updateMany({
      where: { driver: { not: 'LOCAL' } },
      data: { isActive: false },
    });
    const local = await app.prisma.backupStorage.create({
      data: { name: `move-local-${uniqueSuffix()}`, driver: 'LOCAL', isActive: true },
    });

    const accepted = await move({ nodeId: destNodeId });
    assert.equal(accepted.statusCode, 200, accepted.body);

    // With nothing active at all there is nowhere to put the archive, and the
    // refusal has to say so here rather than an hour into the move.
    //
    // "Nothing active" is global, and this database is shared with every other
    // suite running beside it — so the window is one request wide and the
    // restore is in a `finally`. Without that, an assertion failing here would
    // leave the whole run with no storage and take a dozen unrelated suites
    // down with it.
    await app.prisma.server.update({
      where: { id: serverId },
      data: { status: 'OFFLINE', nodeId: sourceNodeId },
    });
    const wereActive = await app.prisma.backupStorage.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    let refused;
    try {
      await app.prisma.backupStorage.updateMany({ data: { isActive: false } });
      refused = await move({ nodeId: destNodeId });
    } finally {
      await app.prisma.backupStorage.updateMany({
        where: { id: { in: wereActive.map((row) => row.id) } },
        data: { isActive: true },
      });
    }

    assert.equal(refused.statusCode, 409, refused.body);
    assert.match(
      refused.json<{ error: { message: string } }>().error.message,
      /backup storage/i,
      'the message has to name the actual obstacle',
    );

    await app.prisma.backupStorage.delete({ where: { id: local.id } }).catch(() => undefined);
    await app.prisma.backupStorage.updateMany({
      where: { id: sharedStorageId },
      data: { isActive: true },
    });
  });

  it('refuses when the destination has no free port', async () => {
    await app.prisma.serverAllocation.updateMany({
      where: { nodeId: destNodeId },
      data: { serverId: serverId },
    });

    const response = await move({ nodeId: destNodeId });
    assert.equal(response.statusCode, 409);
    assert.equal(
      response.json<{ error: { code: string } }>().error.code,
      'NO_ALLOCATION_AVAILABLE',
    );

    await app.prisma.serverAllocation.updateMany({
      where: { nodeId: destNodeId },
      data: { serverId: null },
    });
  });

  it('refuses to move a server that is not in a settled state', async () => {
    for (const status of ['INSTALLING', 'REINSTALLING', 'TRANSFERRING'] as const) {
      await app.prisma.server.update({ where: { id: serverId }, data: { status } });
      const response = await move({ nodeId: destNodeId });
      assert.equal(response.statusCode, 409, `${status} must not be movable`);
    }
  });

  it('is closed to anyone without admin.servers', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/servers/${serverId}/move`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
      payload: { nodeId: destNodeId },
    });
    assert.equal(response.statusCode, 403, 'a customer must not be able to move their own server');
  });

  it('404s for a node that does not exist, without saying more', async () => {
    const response = await move({ nodeId: 'cl00000000000000000000000' });
    assert.equal(response.statusCode, 404);
  });
});
