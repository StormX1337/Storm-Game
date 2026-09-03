import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Node } from '@prisma/client';
import { hashPassword } from '@storm/security';
import { ServerStatus } from '@storm/types';
import { runTransfer } from '../src/workers/transfer.worker.js';
import {
  claimPanelStorage,
  createTestApp,
  deleteUser,
  registerUser,
  uniqueSuffix,
} from './helpers.js';

/**
 * Moving a server on a deployment with no object storage.
 *
 * The move used to be refused outright: the archive travels from one node's
 * disk to the other's, and without a bucket there was no route between them.
 * That meant running S3 to shift a server between two machines you already
 * own, which is a lot to ask of a self-hosted panel.
 *
 * So the panel offers itself as the route. That puts a new thing on the
 * network — an endpoint that streams a server's entire directory to whoever
 * holds a ticket — and the tests here are mostly about that ticket: what it
 * grants, what it does not, and how long it lives.
 */
describe('moving a server without a bucket', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  /** Given back in `after`; see claimPanelStorage. */
  let releaseStorage: () => Promise<void>;
  let sourceNodeId: string;
  let sourceNodeName: string;
  let destNodeId: string;
  let serverId: string;
  let localStorageId: string;
  let sharedStorageId: string;
  const createdUsers: string[] = [];

  /** Every agent call the run made. */
  let calls: { node: string; path: string; method: string; body?: unknown }[] = [];
  /** What the source node's download endpoint hands back. */
  let archiveBytes = 'the-servers-whole-directory';
  let realRequest: FastifyInstance['agents']['request'];
  let realRaw: FastifyInstance['agents']['rawRequest'];

  const restoreBody = (): {
    download?: { driver: string; url?: string; headers?: Record<string, string> };
  } => (calls.find((call) => call.path.includes('/restore'))?.body ?? {}) as never;

  /** The ticket id and secret the destination was told to use. */
  function issuedTicket(): { url: string; secret: string } {
    const download = restoreBody().download;
    assert.ok(download?.url, 'no download URL reached the destination');
    const secret = (download.headers?.authorization ?? '').replace(/^Bearer /, '');
    return { url: download.url, secret };
  }

  const fetchArchive = (url: string, secret: string) =>
    app.inject({
      method: 'GET',
      url: new URL(url).pathname,
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    });

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;
    // The panel has one storage configuration and this suite depends on
    // what it says, so it waits for its turn at it.
    releaseStorage = await claimPanelStorage(app);
    realRequest = app.agents.request;
    realRaw = app.agents.rawRequest;

    app.agents.request = (async (
      node: Node,
      path: string,
      options?: { method?: string; body?: unknown },
    ) => {
      calls.push({ node: node.name, path, method: options?.method ?? 'GET', body: options?.body });
      if (path.endsWith('/backups')) return { bytes: 1024, checksum: 'deadbeef' };
      if (/\/servers\/[^/]+$/.test(path) && (options?.method ?? 'GET') === 'GET') {
        return { status: 'OFFLINE' };
      }
      return {};
    }) as typeof app.agents.request;

    // The source node serving the archive it kept on its own disk.
    app.agents.rawRequest = (async (node: Node, path: string) => {
      calls.push({ node: node.name, path, method: 'GET-raw' });
      return { statusCode: 200, body: Readable.from([archiveBytes]) };
    }) as unknown as typeof app.agents.rawRequest;

    const customer = await registerUser(app);
    createdUsers.push(customer.id);

    const suffix = uniqueSuffix();
    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const owner = await app.prisma.user.create({
      data: {
        email: `tnb-owner-${suffix}@storm.test`,
        username: `tnbowner${suffix}`,
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
    const adminToken = login.json<{ data: { accessToken: string } }>().data.accessToken;

    const makeNode = async (label: string, ip: string) =>
      (
        await app.prisma.node.create({
          data: {
            name: `tnb-${label}-${suffix}`,
            location: 'Test',
            hostname: `${label}-${suffix}.invalid`,
            ip,
            scheme: 'http',
            memoryTotal: 8192,
            diskTotal: 51200,
            status: 'ONLINE',
          },
        })
      ).id;
    sourceNodeId = await makeNode('source', '10.9.0.1');
    sourceNodeName = (await app.prisma.node.findUniqueOrThrow({ where: { id: sourceNodeId } }))
      .name;
    destNodeId = await makeNode('dest', '10.9.0.2');

    await app.prisma.serverAllocation.create({
      data: { nodeId: sourceNodeId, ip: '10.9.0.1', port: 26931 },
    });
    await app.prisma.serverAllocation.create({
      data: { nodeId: destNodeId, ip: '10.9.0.2', port: 26932 },
    });

    // Both kinds exist; which one is active decides the route.
    localStorageId = (
      await app.prisma.backupStorage.create({
        data: { name: `tnb-local-${suffix}`, driver: 'LOCAL', isActive: true },
      })
    ).id;
    sharedStorageId = (
      await app.prisma.backupStorage.create({
        data: {
          name: `tnb-shared-${suffix}`,
          driver: 'S3',
          bucket: 'storm-test',
          region: 'auto',
          endpoint: 'http://127.0.0.1:9000',
          accessKeyEnc: app.encrypter.encrypt('test-access-key'),
          secretKeyEnc: app.encrypter.encrypt('test-secret-key'),
          isActive: false,
        },
      })
    ).id;

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'local-test' },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Moving without a bucket',
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
    archiveBytes = 'the-servers-whole-directory';
    // Back to where it started, so each test moves the same server.
    await app.prisma.server.update({
      where: { id: serverId },
      data: { nodeId: sourceNodeId, status: ServerStatus.OFFLINE },
    });
    await app.prisma.serverAllocation.updateMany({
      where: { nodeId: destNodeId },
      data: { serverId: null, isPrimary: false },
    });
    await app.prisma.serverAllocation.updateMany({
      where: { nodeId: sourceNodeId },
      data: { serverId, isPrimary: true },
    });
    await app.prisma.backupStorage.update({
      where: { id: sharedStorageId },
      data: { isActive: false },
    });
  });

  after(async () => {
    app.agents.request = realRequest;
    app.agents.rawRequest = realRaw;
    for (const nodeId of [sourceNodeId, destNodeId]) {
      await app.prisma.serverAllocation.updateMany({ where: { nodeId }, data: { serverId: null } });
      await app.prisma.server.deleteMany({ where: { nodeId } });
      await app.prisma.serverAllocation.deleteMany({ where: { nodeId } });
      await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    }
    await app.prisma.backupStorage
      .deleteMany({ where: { id: { in: [localStorageId, sharedStorageId] } } })
      .catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await releaseStorage();
    await cleanup();
  });

  const move = (keepBackup = false) =>
    runTransfer(app, {
      serverId,
      destinationNodeId: destNodeId,
      allocationId: null,
      keepBackup,
      userId: null,
    });

  /* ------------------------------------------------------------ the route -- */

  it('keeps the archive on the old node and points the new one at the panel', async () => {
    await move();

    // The archive never left the source's disk: nothing was uploaded anywhere.
    const upload = (calls.find((call) => call.path.endsWith('/backups'))?.body ?? {}) as {
      upload?: { driver: string; url?: string };
    };
    assert.equal(upload.upload?.driver, 'LOCAL');
    assert.equal(upload.upload?.url, undefined, 'there is no bucket to upload to');

    const download = restoreBody().download;
    assert.equal(download?.driver, 'PANEL');
    assert.match(download?.url ?? '', /\/internal\/transfer-archive\//);
    assert.match(download?.headers?.authorization ?? '', /^Bearer .+/);
  });

  it('clears the archive off the old node once the move is done', async () => {
    // The archive is a full copy of the server, and with no bucket it is
    // sitting on the source node's disk. Deleting only from object storage —
    // which is what this did — left it there after every move, and deleted the
    // row that knew where it was in the same breath. Nothing would have found
    // it again; the node just fills up.
    await move();

    const deletions = calls.filter(
      (call) => call.method === 'DELETE' && /\/backups\/[^/]+$/.test(call.path),
    );
    assert.equal(deletions.length, 1, JSON.stringify(calls.map((c) => `${c.method} ${c.path}`)));
    assert.equal(deletions[0]?.node, sourceNodeName, 'asked the wrong node to delete it');
  });

  it('leaves the archive alone when it was asked to keep it', async () => {
    await move(true);

    const deletions = calls.filter(
      (call) => call.method === 'DELETE' && /\/backups\/[^/]+$/.test(call.path),
    );
    assert.deepEqual(deletions, [], 'deleted a backup the operator asked to keep');

    const kept = await app.prisma.backup.findFirst({ where: { serverId } });
    assert.ok(kept, 'the record was deleted too');
  });

  it('still goes straight between the nodes when there is a bucket', async () => {
    await app.prisma.backupStorage.update({
      where: { id: sharedStorageId },
      data: { isActive: true },
    });

    await move();

    const download = restoreBody().download;
    assert.notEqual(download?.driver, 'PANEL', 'the panel should stay out of it when it can');
    assert.ok(
      !(download?.url ?? '').includes('/internal/transfer-archive/'),
      'a bucket was available and the panel routed through itself anyway',
    );
  });

  /* ----------------------------------------------------------- the ticket -- */

  it('streams the archive to a holder of the ticket', async () => {
    await move();
    const { url, secret } = issuedTicket();

    // Reissued, because the move revokes its own ticket when it finishes.
    const ticket = await app.transferArchives.issue({
      backupId: 'backup-under-test',
      sourceNodeId,
      serverUuid: 'server-uuid',
      backupUuid: 'backup-uuid',
    });
    const response = await fetchArchive(url.replace(/[^/]+$/, ticket.id), ticket.secret);

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.body, archiveBytes);
    assert.ok(secret.length > 20, 'the secret has to be worth guarding');
  });

  it('hands nothing to a request without the secret, or with the wrong one', async () => {
    const ticket = await app.transferArchives.issue({
      backupId: 'b',
      sourceNodeId,
      serverUuid: 'server-uuid',
      backupUuid: 'backup-uuid',
    });
    const url = `/api/v1/internal/transfer-archive/${ticket.id}`;

    for (const [label, headers] of [
      ['no header at all', {}],
      ['an empty bearer', { authorization: 'Bearer ' }],
      ['somebody else’s secret', { authorization: `Bearer ${'x'.repeat(43)}` }],
      ['the id used as the secret', { authorization: `Bearer ${ticket.id}` }],
    ] as const) {
      const response = await app.inject({ method: 'GET', url, headers });
      assert.equal(response.statusCode, 401, `${label} → ${response.statusCode}`);
      assert.ok(!response.body.includes(archiveBytes), `${label} got bytes`);
    }
  });

  it('says the same thing about a ticket that never existed', async () => {
    // Otherwise the endpoint answers "wrong secret" for real ids and something
    // else for invented ones, which is a way to learn which ids exist.
    const real = await app.transferArchives.issue({
      backupId: 'b',
      sourceNodeId,
      serverUuid: 'server-uuid',
      backupUuid: 'backup-uuid',
    });
    const wrongSecret = await app.inject({
      method: 'GET',
      url: `/api/v1/internal/transfer-archive/${real.id}`,
      headers: { authorization: `Bearer ${'y'.repeat(43)}` },
    });
    const noSuchTicket = await app.inject({
      method: 'GET',
      url: `/api/v1/internal/transfer-archive/${'z'.repeat(16)}`,
      headers: { authorization: `Bearer ${'y'.repeat(43)}` },
    });

    assert.equal(wrongSecret.statusCode, noSuchTicket.statusCode);
    assert.equal(
      wrongSecret.json<{ error: { message: string } }>().error.message,
      noSuchTicket.json<{ error: { message: string } }>().error.message,
    );
  });

  it('stops working the moment the move is over', async () => {
    await move();
    const { url, secret } = issuedTicket();

    const response = await fetchArchive(url, secret);
    assert.equal(
      response.statusCode,
      401,
      'a granted read of a whole server directory outlived the move that needed it',
    );
  });

  it('keeps the secret out of the store it is written to', async () => {
    const ticket = await app.transferArchives.issue({
      backupId: 'b',
      sourceNodeId,
      serverUuid: 'server-uuid',
      backupUuid: 'backup-uuid',
    });

    const stored = await app.redis.get(`storm:transfer-ticket:${ticket.id}`);
    assert.ok(stored, 'the ticket was not stored at all');
    assert.ok(
      !stored.includes(ticket.secret),
      'a dump of Redis would be a set of working download links',
    );

    await app.transferArchives.revoke(ticket.id);
  });

  it('expires on its own, so a forgotten ticket is not a permanent key', async () => {
    const ticket = await app.transferArchives.issue({
      backupId: 'b',
      sourceNodeId,
      serverUuid: 'server-uuid',
      backupUuid: 'backup-uuid',
    });

    const ttl = await app.redis.ttl(`storm:transfer-ticket:${ticket.id}`);
    assert.ok(ttl > 0, 'the ticket never expires');
    assert.ok(ttl <= 6 * 3600, `it lives ${ttl}s, longer than a presigned URL would`);

    await app.transferArchives.revoke(ticket.id);
  });
});
