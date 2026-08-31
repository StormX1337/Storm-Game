import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Node } from '@storm/database';
import { hashPassword } from '@storm/security';
import { runTransfer } from '../src/workers/transfer.worker.js';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';

/**
 * The move itself, with the node agents replaced by a stub.
 *
 * Two things matter here and neither needs a real node: which address ends up
 * baked into the server that arrives, and what is left behind when a move dies
 * half way through.
 */
describe('the move, step by step', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let adminToken: string;
  let sourceNodeId: string;
  let destNodeId: string;
  let serverId: string;
  let storageId: string;
  let sourceAllocationId: string;
  let destAllocationId: string;
  const createdUsers: string[] = [];
  const nodeIds: string[] = [];

  const SOURCE_PORT = 26911;
  const DEST_PORT = 26912;

  /** Every agent call the run made, so the order can be asserted. */
  let calls: { node: string; path: string; method: string; body?: unknown }[] = [];
  let failOn: ((path: string) => boolean) | null = null;
  let realRequest: FastifyInstance['agents']['request'];

  function stubAgents(): void {
    app.agents.request = (async (
      node: Node,
      path: string,
      options?: { method?: string; body?: unknown },
    ) => {
      calls.push({ node: node.name, path, method: options?.method ?? 'GET', body: options?.body });
      if (failOn?.(path)) throw new Error(`stub failure on ${path}`);
      // The shape each caller reads back.
      if (path.endsWith('/backups')) return { bytes: 1024, checksum: 'deadbeef' };
      if (/\/servers\/[^/]+$/.test(path) && (options?.method ?? 'GET') === 'GET') {
        return { status: 'OFFLINE' };
      }
      return {};
    }) as typeof app.agents.request;
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;
    realRequest = app.agents.request;

    const customer = await registerUser(app);
    createdUsers.push(customer.id);

    const suffix = uniqueSuffix();
    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const owner = await app.prisma.user.create({
      data: {
        email: `tw-owner-${suffix}@storm.test`,
        username: `twowner${suffix}`,
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

    const makeNode = async (label: string) => {
      const node = await app.prisma.node.create({
        data: {
          name: `tw-${label}-${suffix}`,
          location: 'Test',
          hostname: `${label}.invalid`,
          ip: label === 'source' ? '10.0.0.1' : '10.0.0.2',
          scheme: 'http',
          memoryTotal: 8192,
          diskTotal: 51200,
          status: 'ONLINE',
        },
      });
      nodeIds.push(node.id);
      return node.id;
    };
    sourceNodeId = await makeNode('source');
    destNodeId = await makeNode('dest');

    const sourceAllocation = await app.prisma.serverAllocation.create({
      data: { nodeId: sourceNodeId, ip: '10.0.0.1', port: SOURCE_PORT },
    });
    sourceAllocationId = sourceAllocation.id;
    const destAllocation = await app.prisma.serverAllocation.create({
      data: { nodeId: destNodeId, ip: '10.0.0.2', port: DEST_PORT },
    });
    destAllocationId = destAllocation.id;

    const storage = await app.prisma.backupStorage.create({
      data: {
        name: `tw-storage-${suffix}`,
        driver: 'S3',
        bucket: 'storm-test',
        region: 'auto',
        endpoint: 'http://127.0.0.1:9000',
        accessKeyEnc: app.encrypter.encrypt('test-access-key'),
        secretKeyEnc: app.encrypter.encrypt('test-secret-key'),
        isActive: true,
      },
    });
    storageId = storage.id;

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Mover',
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
    calls = [];
    failOn = null;
    stubAgents();
    await app.prisma.backup.deleteMany({ where: { serverId } });
    await app.prisma.serverAllocation.update({
      where: { id: sourceAllocationId },
      data: { serverId, isPrimary: true },
    });
    await app.prisma.serverAllocation.update({
      where: { id: destAllocationId },
      data: { serverId: null, isPrimary: false },
    });
    await app.prisma.server.update({
      where: { id: serverId },
      data: { nodeId: sourceNodeId, status: 'OFFLINE' },
    });
  });

  after(async () => {
    app.agents.request = realRequest;
    await app.prisma.backup.deleteMany({ where: { serverId } });
    for (const nodeId of nodeIds) {
      await app.prisma.serverAllocation.updateMany({ where: { nodeId }, data: { serverId: null } });
      await app.prisma.server.deleteMany({ where: { nodeId } });
      await app.prisma.serverAllocation.deleteMany({ where: { nodeId } });
      await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    }
    await app.prisma.backupStorage.delete({ where: { id: storageId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  const job = () => ({
    serverId,
    destinationNodeId: destNodeId,
    allocationId: null,
    keepBackup: false,
    userId: null,
  });

  /* ------------------------------------------ the address that arrives -- */

  it("builds the arriving server from the destination's address, not the old one", async () => {
    // The failure this guards against is quiet and expensive: mid-move the
    // server holds ports on both nodes, and if the old one wins it is written
    // into SERVER_IP, the startup command and every config file the template
    // renders. The server comes up on the new node bound to an address that is
    // not there. So this reads the spec the destination was actually sent,
    // rather than calling the builder itself — the builder taking an override
    // proves nothing if the move does not pass one.
    await runTransfer(app, job());

    const create = calls.find((c) => c.path === '/api/v1/servers' && c.method === 'PUT');
    assert.ok(create, 'the destination has to be sent a specification');
    const spec = create.body as {
      environment: Record<string, string>;
      ports: { ip: string; port: number }[];
    };

    assert.equal(spec.environment.SERVER_PORT, String(DEST_PORT));
    assert.equal(spec.environment.SERVER_IP, '10.0.0.2');
    assert.deepEqual(
      spec.ports.map((port) => port.port),
      [DEST_PORT],
      'the container must publish the destination port and only that',
    );
  });

  it('still reads the row when no override is given', async () => {
    const spec = await app.servers.buildAgentSpec(serverId);
    assert.equal(spec.environment.SERVER_PORT, String(SOURCE_PORT));
  });

  /* ------------------------------------------------------- the ordering -- */

  it('archives from the old node and restores onto the new one', async () => {
    await runTransfer(app, job());

    const backupCall = calls.find((c) => c.path.endsWith('/backups') && c.method === 'POST');
    const restoreCall = calls.find((c) => c.path.includes('/restore'));
    const createCall = calls.find((c) => c.path === '/api/v1/servers' && c.method === 'PUT');

    assert.ok(backupCall, 'the archive has to be made somewhere');
    assert.match(backupCall.node, /source/, 'the archive is made where the files are');
    assert.ok(createCall, 'the container has to be built on the destination');
    assert.match(createCall.node, /dest/);
    assert.ok(restoreCall, 'and the archive unpacked there');
    assert.match(restoreCall.node, /dest/);

    const server = await app.prisma.server.findUniqueOrThrow({ where: { id: serverId } });
    assert.equal(server.nodeId, destNodeId, 'the row follows the files');
    assert.equal(server.status, 'OFFLINE');
  });

  it('hands the old ports back and takes the new one', async () => {
    await runTransfer(app, job());

    const source = await app.prisma.serverAllocation.findUniqueOrThrow({
      where: { id: sourceAllocationId },
    });
    const destination = await app.prisma.serverAllocation.findUniqueOrThrow({
      where: { id: destAllocationId },
    });

    assert.equal(source.serverId, null, 'the old port is free for the next server');
    assert.equal(source.isPrimary, false);
    assert.equal(destination.serverId, serverId);
    assert.equal(destination.isPrimary, true);
  });

  it('removes the server from the old node once the new one has it', async () => {
    await runTransfer(app, job());

    const deletion = calls.find((c) => c.method === 'DELETE');
    assert.ok(deletion, 'leaving the files behind would fill the old node');
    assert.match(deletion.node, /source/);
  });

  it('does not keep the archive it moved through, unless asked', async () => {
    await runTransfer(app, job());
    assert.equal(
      await app.prisma.backup.count({ where: { serverId } }),
      0,
      "the move's own copy should not spend the customer's backup allowance",
    );

    await app.prisma.server.update({
      where: { id: serverId },
      data: { nodeId: sourceNodeId },
    });
    await app.prisma.serverAllocation.update({
      where: { id: sourceAllocationId },
      data: { serverId, isPrimary: true },
    });
    await app.prisma.serverAllocation.update({
      where: { id: destAllocationId },
      data: { serverId: null, isPrimary: false },
    });

    await runTransfer(app, { ...job(), keepBackup: true });
    assert.equal(await app.prisma.backup.count({ where: { serverId } }), 1);
  });

  /* ------------------------------------------------- when it goes wrong -- */

  for (const [label, failing] of [
    ['the archive cannot be made', (p: string) => p.endsWith('/backups')],
    ['the new node will not build the container', (p: string) => p === '/api/v1/servers'],
    ['the archive will not unpack on the new node', (p: string) => p.includes('/restore')],
  ] as const) {
    it(`leaves the server where it was when ${label}`, async () => {
      failOn = failing;

      await assert.rejects(runTransfer(app, job()));

      const server = await app.prisma.server.findUniqueOrThrow({ where: { id: serverId } });
      assert.equal(
        server.nodeId,
        sourceNodeId,
        'a failed move must not have handed the server to the other node',
      );
      assert.notEqual(server.status, 'TRANSFERRING', 'and must not leave it stuck mid-move');

      const source = await app.prisma.serverAllocation.findUniqueOrThrow({
        where: { id: sourceAllocationId },
      });
      assert.equal(source.serverId, serverId, 'it still owns the port it is actually running on');

      const destination = await app.prisma.serverAllocation.findUniqueOrThrow({
        where: { id: destAllocationId },
      });
      assert.equal(
        destination.serverId,
        null,
        'and the port it never got to use is free for someone else',
      );
    });
  }

  it('never deletes the source when the move failed', async () => {
    failOn = (path: string) => path.includes('/restore');
    await assert.rejects(runTransfer(app, job()));

    const sourceDeletions = calls.filter((c) => c.method === 'DELETE' && /source/.test(c.node));
    assert.equal(
      sourceDeletions.length,
      0,
      'the only copy of the world is on the source node at that point',
    );
  });
});
