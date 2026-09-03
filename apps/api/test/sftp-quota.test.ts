import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { generateToken, hashToken } from '@storm/security';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * The other door into a customer's files.
 *
 * The disk limit is a promise the panel makes and the file manager keeps: an
 * upload from a server that is over its limit is refused. SFTP is the same
 * files through a different door, and it answered `writable: true` to
 * everyone — so the customer who could not drag a modpack in through the
 * browser dragged it in over SFTP instead, and the node filled up anyway.
 *
 * Read-only rather than closed. Being over a limit has to be a state somebody
 * can get out of, so a session that cannot add bytes can still list, read,
 * delete and rename.
 */
describe('an SFTP session and the disk limit', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let customer: RegisteredUser;
  let nodeId: string;
  let credentials: string;
  let serverId: string;
  let sftpUsername: string;
  const sftpPassword = 'a-long-generated-server-password';
  const DISK_MB = 2048;
  const createdUsers: string[] = [];

  async function auth(password = sftpPassword) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/internal/sftp/auth',
      headers: { authorization: `Bearer ${credentials}` },
      payload: { username: sftpUsername, password },
    });
  }

  async function report(usedMb: number): Promise<void> {
    await app.prisma.serverStat.create({
      data: { serverId, diskBytes: BigInt(usedMb) * 1024n * 1024n },
    });
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    customer = await registerUser(app);
    createdUsers.push(customer.id);
    const suffix = uniqueSuffix();

    const node = await app.prisma.node.create({
      data: {
        name: `sftp-node-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 8192,
        diskTotal: 51200,
        status: 'ONLINE',
      },
    });
    nodeId = node.id;

    const tokenId = generateToken(8).slice(0, 12);
    const token = generateToken(32);
    await app.prisma.nodeToken.create({
      data: {
        nodeId,
        name: 'sftp test',
        tokenId,
        tokenHash: hashToken(token),
        secretEnc: app.encrypter.encrypt(generateToken(32)),
      },
    });
    credentials = `${tokenId}.${token}`;

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    sftpUsername = `sftpq.${suffix}`;
    const server = await app.prisma.server.create({
      data: {
        name: 'Files over SFTP',
        shortId: uniqueSuffix().slice(0, 8),
        ownerId: customer.id,
        nodeId,
        templateId: template.id,
        dockerImage: 'alpine',
        startupCommand: 'true',
        sftpUsername,
        sftpPasswordEnc: app.encrypter.encrypt(sftpPassword),
        diskLimit: DISK_MB,
        status: 'OFFLINE',
      },
    });
    serverId = server.id;
  });

  after(async () => {
    await app.prisma.serverStat.deleteMany({ where: { serverId } });
    await app.prisma.nodeToken.deleteMany({ where: { nodeId } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    await app.prisma.serverStat.deleteMany({ where: { serverId } });
    await app.prisma.server.update({
      where: { id: serverId },
      data: { diskLimit: DISK_MB, suspendedAt: null },
    });
    await app.prisma.user.update({ where: { id: customer.id }, data: { suspendedAt: null } });
  });

  it('lets a session write while there is room', async () => {
    await report(DISK_MB / 2);
    const response = await auth();

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<{ data: { writable: boolean } }>().data.writable, true);
  });

  it('hands back a read-only session once the server is over its limit', async () => {
    // The file manager refuses an upload here. Saying writable anyway is what
    // made SFTP the way around the quota.
    await report(DISK_MB + 64);
    const response = await auth();

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(
      response.json<{ data: { writable: boolean } }>().data.writable,
      false,
      'SFTP is still the way around the disk limit',
    );
  });

  it('still lets them in, so they can delete their way out', async () => {
    // Refusing the login would leave somebody over their limit with no way
    // to get back under it except asking support.
    await report(DISK_MB * 4);
    const response = await auth();
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.json<{ data: { uuid: string } }>().data.uuid);
  });

  it('writes freely for a server sold no limit at all', async () => {
    await app.prisma.server.update({ where: { id: serverId }, data: { diskLimit: 0 } });
    await report(500_000);

    const response = await auth();
    assert.equal(response.json<{ data: { writable: boolean } }>().data.writable, true);
  });

  it('writes freely before the server has ever reported', async () => {
    // A brand-new server has no sample. Refusing here would make the first
    // upload to every new server fail.
    const response = await auth();
    assert.equal(response.json<{ data: { writable: boolean } }>().data.writable, true);
  });

  it('records in the activity log which kind of session it was', async () => {
    await report(DISK_MB + 1);
    await auth();

    const entry = await app.prisma.activityLog.findFirst({
      where: { serverId, event: 'sftp:login' },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(entry, 'the login was not recorded');
    assert.equal((entry.metadata as { writable?: boolean }).writable, false);
  });

  /* --------------------------------------------------- the door itself -- */

  it('refuses the wrong password without saying which part was wrong', async () => {
    const response = await auth('not-the-password');
    assert.equal(response.statusCode, 401, response.body);
    assert.match(response.body, /Invalid SFTP credentials/);
  });

  it('refuses a suspended server and a suspended account', async () => {
    await app.prisma.server.update({ where: { id: serverId }, data: { suspendedAt: new Date() } });
    assert.equal((await auth()).statusCode, 401);

    await app.prisma.server.update({ where: { id: serverId }, data: { suspendedAt: null } });
    await app.prisma.user.update({ where: { id: customer.id }, data: { suspendedAt: new Date() } });
    assert.equal((await auth()).statusCode, 401);
  });

  it('will not authenticate a server that belongs to another node', async () => {
    // The username is the only thing the client sends, and it is not secret.
    // Without the node in the lookup, one node's token would open every
    // server in the panel.
    const other = await app.prisma.node.create({
      data: {
        name: `sftp-other-${uniqueSuffix()}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 1024,
        diskTotal: 10240,
      },
    });
    const tokenId = generateToken(8).slice(0, 12);
    const token = generateToken(32);
    await app.prisma.nodeToken.create({
      data: {
        nodeId: other.id,
        name: 'other',
        tokenId,
        tokenHash: hashToken(token),
        secretEnc: app.encrypter.encrypt(generateToken(32)),
      },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/sftp/auth',
        headers: { authorization: `Bearer ${tokenId}.${token}` },
        payload: { username: sftpUsername, password: sftpPassword },
      });
      assert.equal(response.statusCode, 401, response.body);
    } finally {
      await app.prisma.nodeToken.deleteMany({ where: { nodeId: other.id } });
      await app.prisma.node.delete({ where: { id: other.id } }).catch(() => undefined);
    }
  });

  it('is closed to anyone without a node token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/internal/sftp/auth',
      headers: { authorization: `Bearer ${customer.accessToken}` },
      payload: { username: sftpUsername, password: sftpPassword },
    });
    assert.equal(response.statusCode, 401, response.body);
  });
});
