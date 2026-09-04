import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Permission, ServerStatus } from '@storm/types';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Sharing a server with somebody else.
 *
 * The reading end of this is well covered — a share is a ceiling, not a
 * source, and every route intersects it with what the caller holds right now.
 * The granting end had no tests at all, and it is where the ceiling is set:
 * who may share, what they may hand over, and whether handing it over can ever
 * be a way to end up with more than you started with.
 */
describe('sharing a server', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let owner: RegisteredUser;
  let manager: RegisteredUser;
  let helper: RegisteredUser;
  let stranger: RegisteredUser;
  let serverId: string;
  let nodeId: string;
  const createdUsers: string[] = [];

  const as = (user: RegisteredUser) => ({ authorization: `Bearer ${user.accessToken}` });

  const share = (payload: Record<string, unknown>, user: RegisteredUser) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/subusers`,
      headers: as(user),
      payload,
    });

  const listShares = (user: RegisteredUser) =>
    app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/subusers`, headers: as(user) });

  const permissionsOf = async (userId: string): Promise<string[]> =>
    (
      await app.prisma.serverSubuser.findUnique({
        where: { serverId_userId: { serverId, userId } },
      })
    )?.permissions ?? [];

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    owner = await registerUser(app);
    manager = await registerUser(app);
    helper = await registerUser(app);
    stranger = await registerUser(app);
    createdUsers.push(owner.id, manager.id, helper.id, stranger.id);
    const suffix = uniqueSuffix();

    const node = await app.prisma.node.create({
      data: {
        name: `share-node-${suffix}`,
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

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    serverId = (
      await app.prisma.server.create({
        data: {
          name: 'Shared',
          shortId: uniqueSuffix().slice(0, 8),
          ownerId: owner.id,
          nodeId,
          templateId: template.id,
          dockerImage: 'alpine',
          startupCommand: 'true',
          sftpUsername: `share_${suffix}`,
          sftpPasswordEnc: 'not-a-real-secret',
          status: ServerStatus.OFFLINE,
          installedAt: new Date(),
        },
      })
    ).id;
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
    for (const user of [manager, helper, stranger]) {
      await app.prisma.user.update({
        where: { id: user.id },
        data: { deniedPermissions: [], suspendedAt: null },
      });
    }
  });

  /* ------------------------------------------------------ who may share -- */

  it('lets the owner share their server', async () => {
    const response = await share(
      { email: helper.email, permissions: [Permission.SERVERS_CONSOLE] },
      owner,
    );
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(await permissionsOf(helper.id), [Permission.SERVERS_CONSOLE]);
  });

  it('does not let a stranger share somebody else’s server', async () => {
    const response = await share(
      { email: helper.email, permissions: [Permission.SERVERS_CONSOLE] },
      stranger,
    );
    // 404, not 403: a server they cannot see must not be confirmed to exist.
    assert.equal(response.statusCode, 404, response.body);
  });

  it('does not let a sub-user without the permission share it on', async () => {
    await app.prisma.serverSubuser.create({
      data: { serverId, userId: helper.id, permissions: [Permission.SERVERS_CONSOLE] },
    });

    const response = await share(
      { email: stranger.email, permissions: [Permission.SERVERS_CONSOLE] },
      helper,
    );
    assert.equal(response.statusCode, 403, response.body);
  });

  it('refuses to share with somebody who does not have an account', async () => {
    const response = await share(
      { email: `nobody-${uniqueSuffix()}@storm.test`, permissions: [Permission.SERVERS_CONSOLE] },
      owner,
    );
    assert.equal(response.statusCode, 404, response.body);
  });

  it('refuses to share a server with its own owner', async () => {
    const response = await share(
      { email: owner.email, permissions: [Permission.SERVERS_CONSOLE] },
      owner,
    );
    assert.equal(response.statusCode, 400, response.body);
  });

  /* ---------------------------------------------- what may be handed over -- */

  it('will not hand over a permission the granter does not hold themselves', async () => {
    // The whole point of delegation having a ceiling: a customer cannot grant
    // administration of the panel just because it is their server.
    const response = await share(
      { email: helper.email, permissions: [Permission.ADMIN_SERVERS] },
      owner,
    );
    assert.equal(response.statusCode, 403, response.body);
    assert.deepEqual(await permissionsOf(helper.id), []);
  });

  it('will not let a delegated manager hand on more than they were given', async () => {
    // A sub-user who may share can pass on what they hold and no more —
    // otherwise sharing would be a way of growing your own access by proxy.
    await app.prisma.serverSubuser.create({
      data: {
        serverId,
        userId: manager.id,
        permissions: [Permission.SERVERS_SUBUSERS, Permission.SERVERS_CONSOLE],
      },
    });

    const response = await share(
      {
        email: helper.email,
        permissions: [Permission.SERVERS_CONSOLE, Permission.SERVERS_DELETE],
      },
      manager,
    );
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      await permissionsOf(helper.id),
      [Permission.SERVERS_CONSOLE],
      'a manager passed on a permission they did not hold',
    );
  });

  it('is bounded by what the granter holds now, not what their share says', async () => {
    // The share is a ceiling and the account is another; an administrator
    // denying a permission on the account has to reach the sharing route too.
    await app.prisma.serverSubuser.create({
      data: {
        serverId,
        userId: manager.id,
        permissions: [Permission.SERVERS_SUBUSERS, Permission.SERVERS_CONSOLE],
      },
    });
    await app.prisma.user.update({
      where: { id: manager.id },
      data: { deniedPermissions: [Permission.SERVERS_CONSOLE] },
    });

    const response = await share(
      { email: helper.email, permissions: [Permission.SERVERS_CONSOLE] },
      manager,
    );
    assert.equal(response.statusCode, 403, response.body);
    assert.deepEqual(await permissionsOf(helper.id), []);
  });

  it('replaces the permissions on an existing share rather than adding a second', async () => {
    await share({ email: helper.email, permissions: [Permission.SERVERS_CONSOLE] }, owner);
    await share({ email: helper.email, permissions: [Permission.SERVERS_FILES] }, owner);

    const rows = await app.prisma.serverSubuser.findMany({ where: { serverId } });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.permissions, [Permission.SERVERS_FILES]);
  });

  /* --------------------------------------------------------- seeing it -- */

  it('shows the owner who else has access', async () => {
    await share({ email: helper.email, permissions: [Permission.SERVERS_CONSOLE] }, owner);

    const response = await listShares(owner);
    assert.equal(response.statusCode, 200, response.body);
    const rows = response.json<{ data: { email: string }[] }>().data;
    assert.deepEqual(
      rows.map((row) => row.email),
      [helper.email],
    );
  });

  it('does not show the list to a sub-user who was not given that', async () => {
    await app.prisma.serverSubuser.create({
      data: { serverId, userId: helper.id, permissions: [Permission.SERVERS_CONSOLE] },
    });

    const response = await listShares(helper);
    assert.equal(response.statusCode, 403, response.body);
  });

  /* --------------------------------------------------------- removing -- */

  it('lets the owner take access away again', async () => {
    await share({ email: helper.email, permissions: [Permission.SERVERS_CONSOLE] }, owner);
    const row = await app.prisma.serverSubuser.findUniqueOrThrow({
      where: { serverId_userId: { serverId, userId: helper.id } },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${serverId}/subusers/${row.id}`,
      headers: as(owner),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(await permissionsOf(helper.id), []);
  });

  it('cannot remove a share belonging to a different server', async () => {
    // The id alone must not be enough: it is scoped to the server in the URL,
    // and that server is the one access was checked against.
    const other = await app.prisma.server.create({
      data: {
        name: 'Someone else',
        shortId: uniqueSuffix().slice(0, 8),
        ownerId: stranger.id,
        nodeId,
        templateId: (
          await app.prisma.gameTemplate.findFirstOrThrow({ where: { slug: 'minecraft-java' } })
        ).id,
        dockerImage: 'alpine',
        startupCommand: 'true',
        sftpUsername: `other_${uniqueSuffix()}`,
        sftpPasswordEnc: 'not-a-real-secret',
        status: ServerStatus.OFFLINE,
        installedAt: new Date(),
      },
    });
    const foreign = await app.prisma.serverSubuser.create({
      data: { serverId: other.id, userId: helper.id, permissions: [Permission.SERVERS_CONSOLE] },
    });

    try {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/servers/${serverId}/subusers/${foreign.id}`,
        headers: as(owner),
      });
      // The route answers cheerfully either way; what matters is the row.
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(
        await app.prisma.serverSubuser.findUnique({ where: { id: foreign.id } }),
        'removed a share on a server the caller has nothing to do with',
      );
    } finally {
      await app.prisma.serverSubuser.deleteMany({ where: { serverId: other.id } });
      await app.prisma.server.delete({ where: { id: other.id } });
    }
  });
});
