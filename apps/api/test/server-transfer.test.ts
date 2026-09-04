import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '@storm/security';
import { Permission, ServerStatus } from '@storm/types';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Handing a server to a different owner.
 *
 * The route changed one column, and ownership is not one column. Everything
 * that grants access to a server was set up by the person who used to own it:
 * the SFTP credentials they were shown, the people they shared it with, the
 * database passwords they copied out. None of it refers to the owner, so none
 * of it noticed the owner changing.
 *
 * The new owner sees a server that is theirs. The old one still has the keys.
 */
describe('transferring a server to a new owner', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let adminToken: string;
  let previous: RegisteredUser;
  let next: RegisteredUser;
  let friend: RegisteredUser;
  let serverId: string;
  let nodeId: string;
  const createdUsers: string[] = [];

  const asAdmin = () => ({ authorization: `Bearer ${adminToken}` });

  const transferTo = (ownerId: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/admin/servers/${serverId}/transfer`,
      headers: asAdmin(),
      payload: { ownerId },
    });

  const server = () => app.prisma.server.findUniqueOrThrow({ where: { id: serverId } });

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    previous = await registerUser(app);
    next = await registerUser(app);
    friend = await registerUser(app);
    createdUsers.push(previous.id, next.id, friend.id);

    const suffix = uniqueSuffix();
    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const admin = await app.prisma.user.create({
      data: {
        email: `transfer-admin-${suffix}@storm.test`,
        username: `tadmin${suffix}`,
        passwordHash: await hashPassword('TransferAdmin123!'),
        roleId: ownerRole.id,
        emailVerifiedAt: new Date(),
      },
    });
    createdUsers.push(admin.id);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: admin.email, password: 'TransferAdmin123!' },
    });
    adminToken = login.json<{ data: { accessToken: string } }>().data.accessToken;

    const node = await app.prisma.node.create({
      data: {
        name: `transfer-node-${suffix}`,
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
  });

  after(async () => {
    await app.prisma.serverSubuser.deleteMany({ where: { serverId } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    await app.prisma.serverSubuser.deleteMany({ where: { serverId } });
    await app.prisma.server.deleteMany({ where: { nodeId } });

    const suffix = uniqueSuffix();
    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    serverId = (
      await app.prisma.server.create({
        data: {
          name: 'Handed over',
          shortId: suffix.slice(0, 8),
          ownerId: previous.id,
          nodeId,
          templateId: template.id,
          dockerImage: 'alpine',
          startupCommand: 'true',
          sftpUsername: `xfer_${suffix}`,
          sftpPasswordEnc: app.encrypter.encrypt('the-old-owner-knows-this'),
          status: ServerStatus.OFFLINE,
          installedAt: new Date(),
        },
      })
    ).id;
  });

  it('changes who owns it', async () => {
    const response = await transferTo(next.id);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await server()).ownerId, next.id);
  });

  it('takes away the shares the previous owner had handed out', async () => {
    // A share is a relationship between the old owner and their friend. The
    // new owner never agreed to it and cannot see that it exists until they
    // go looking — and the friend keeps whatever they were given.
    await app.prisma.serverSubuser.create({
      data: { serverId, userId: friend.id, permissions: [Permission.SERVERS_CONSOLE] },
    });

    await transferTo(next.id);

    assert.equal(
      await app.prisma.serverSubuser.count({ where: { serverId } }),
      0,
      'the previous owner’s friend still has access to a server that changed hands',
    );
  });

  it('changes the SFTP password the previous owner was shown', async () => {
    // SFTP credentials belong to the server, not to a person: the panel looks
    // up the username and compares the password, and never asks who owns it.
    // So the old owner keeps full file access, indefinitely, and nothing in
    // the panel shows that they do.
    const before = (await server()).sftpPasswordEnc;

    await transferTo(next.id);

    const after = (await server()).sftpPasswordEnc;
    assert.notEqual(
      app.encrypter.tryDecrypt(after),
      app.encrypter.tryDecrypt(before),
      'the previous owner’s SFTP password still opens the server',
    );
  });

  it('leaves a server alone when the transfer is refused', async () => {
    const shared = await app.prisma.serverSubuser.create({
      data: { serverId, userId: friend.id, permissions: [Permission.SERVERS_CONSOLE] },
    });
    const before = (await server()).sftpPasswordEnc;

    const response = await transferTo('no-such-user-id');
    assert.equal(response.statusCode, 404, response.body);

    assert.equal((await server()).ownerId, previous.id);
    assert.equal((await server()).sftpPasswordEnc, before);
    assert.ok(await app.prisma.serverSubuser.findUnique({ where: { id: shared.id } }));
  });

  it('writes down where it went, and what it revoked on the way', async () => {
    await app.prisma.serverSubuser.create({
      data: { serverId, userId: friend.id, permissions: [Permission.SERVERS_CONSOLE] },
    });

    await transferTo(next.id);

    const entry = await app.prisma.auditLog.findFirst({
      where: { targetId: serverId, action: 'admin.server_transferred' },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(entry, 'the transfer was not written down');
    const metadata = entry.metadata as Record<string, unknown>;
    assert.equal(metadata.from, previous.id);
    assert.equal(metadata.to, next.id);
    assert.equal(
      metadata.revokedShares,
      1,
      `the audit entry does not say what access was taken away: ${JSON.stringify(metadata)}`,
    );
  });
});
