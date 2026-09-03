import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Permission, ServerStatus } from '@storm/types';
import { hashPassword } from '@storm/security';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * What somebody may do on a server that is not theirs.
 *
 * A share hands out permissions on one server, and the panel used to take that
 * list on its own. Two things stopped applying the moment a server was shared
 * with you.
 *
 * An administrator's denial — "this account may not send console commands" —
 * was subtracted from the account's own permissions and nowhere else, so it
 * held on your own servers and lapsed on everyone else's. And a scoped API key
 * was ignored here entirely: a key made to read a server list could power one
 * off, as long as the server had been shared with its owner.
 *
 * A share is a ceiling, not a source. What the owner granted is the most you
 * can do here, and you still have to be allowed to do it at all.
 */
describe('a server shared with somebody', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let owner: RegisteredUser;
  let helper: RegisteredUser;
  let adminToken: string;
  let serverId: string;
  let serverShortId: string;
  let nodeId: string;
  const createdUsers: string[] = [];

  /** Gated on servers.start, and refused before the body is looked at. */
  const power = (token: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverShortId}/power`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'start' },
    });

  const view = (token: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverShortId}`,
      headers: { authorization: `Bearer ${token}` },
    });

  async function share(permissions: string[]): Promise<void> {
    await app.prisma.serverSubuser.upsert({
      where: { serverId_userId: { serverId, userId: helper.id } },
      create: { serverId, userId: helper.id, permissions },
      update: { permissions },
    });
  }

  async function makeKey(permissions: string[]): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/account/api-keys',
      headers: { authorization: `Bearer ${helper.accessToken}` },
      payload: { name: `key-${uniqueSuffix().slice(0, 6)}`, permissions },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{ data: { token: string } }>().data.token;
  }

  async function denyOnAccount(permissions: string[]): Promise<void> {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${helper.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { deniedPermissions: permissions },
    });
    assert.equal(response.statusCode, 200, response.body);
  }

  /** A token minted after the change, since one carries what it was given. */
  async function freshToken(user: RegisteredUser): Promise<string> {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: user.email, password: user.password },
    });
    return login.json<{ data: { accessToken: string } }>().data.accessToken;
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    owner = await registerUser(app);
    helper = await registerUser(app);
    createdUsers.push(owner.id, helper.id);

    const suffix = uniqueSuffix();
    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const admin = await app.prisma.user.create({
      data: {
        email: `share-owner-${suffix}@storm.test`,
        username: `shareowner${suffix}`,
        passwordHash: await hashPassword('OwnerPassword123!'),
        roleId: ownerRole.id,
        emailVerifiedAt: new Date(),
      },
    });
    createdUsers.push(admin.id);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: admin.email, password: 'OwnerPassword123!' },
    });
    adminToken = login.json<{ data: { accessToken: string } }>().data.accessToken;

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
    const server = await app.prisma.server.create({
      data: {
        name: 'Shared survival',
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
    });
    serverId = server.id;
    serverShortId = server.shortId;
  });

  after(async () => {
    await app.prisma.apiKey.deleteMany({ where: { userId: { in: createdUsers } } });
    await app.prisma.serverSubuser.deleteMany({ where: { serverId } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    await denyOnAccount([]);
    await share([Permission.SERVERS_VIEW, Permission.SERVERS_START]);
    helper = { ...helper, accessToken: await freshToken(helper) };
  });

  it('lets a share do what the owner granted', async () => {
    assert.equal((await view(helper.accessToken)).statusCode, 200);
    assert.notEqual((await power(helper.accessToken)).statusCode, 403);
  });

  it('does not let a share do what the owner did not grant', async () => {
    await share([Permission.SERVERS_VIEW]);
    assert.equal((await view(helper.accessToken)).statusCode, 200);
    assert.equal((await power(helper.accessToken)).statusCode, 403);
  });

  it('keeps an account-level denial in force on somebody else’s server', async () => {
    // The whole point of the deny list. Stopping someone powering servers
    // around must not lapse because a friend shared one with them.
    await denyOnAccount([Permission.SERVERS_START]);
    const token = await freshToken(helper);

    assert.equal((await power(token)).statusCode, 403, 'the denial stopped at the share');
    // And only the denied one: they can still see the server.
    assert.equal((await view(token)).statusCode, 200);
  });

  it('lifts the denial again when it is taken off the account', async () => {
    await denyOnAccount([Permission.SERVERS_START]);
    assert.equal((await power(await freshToken(helper))).statusCode, 403);

    await denyOnAccount([]);
    assert.notEqual((await power(await freshToken(helper))).statusCode, 403);
  });

  it('honours a scoped API key on a shared server too', async () => {
    // A key that can read a server list could power one off, as long as it had
    // been shared with its owner — the share was read straight from the
    // database and the key never came into it.
    const readOnly = await makeKey([Permission.SERVERS_VIEW]);

    assert.equal((await view(readOnly)).statusCode, 200);
    assert.equal((await power(readOnly)).statusCode, 403, 'the key was ignored on a share');
  });

  it('still lets a key do what it was scoped to', async () => {
    const powerKey = await makeKey([Permission.SERVERS_VIEW, Permission.SERVERS_START]);
    assert.notEqual((await power(powerKey)).statusCode, 403);
  });

  it('honours a scoped API key held by the person who runs the panel', async () => {
    // The same rule from the other side, and the case that was missing it: an
    // account with the OWNER role took the whole customer set on every server
    // without narrowing at all. A key that account scoped to "view servers"
    // could power any server in the panel off.
    const readOnly = await app.inject({
      method: 'POST',
      url: '/api/v1/account/api-keys',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'read only', permissions: [Permission.SERVERS_VIEW] },
    });
    assert.equal(readOnly.statusCode, 200, readOnly.body);
    const token = readOnly.json<{ data: { token: string } }>().data.token;

    assert.equal((await view(token)).statusCode, 200);
    assert.equal((await power(token)).statusCode, 403, 'a scoped key ran unscoped for an owner');
  });

  it('gives somebody with no share at all nothing to look at', async () => {
    await app.prisma.serverSubuser.deleteMany({ where: { serverId } });
    const stranger = await registerUser(app);
    createdUsers.push(stranger.id);

    // Not found rather than forbidden: which servers exist is not something a
    // stranger gets to learn by asking.
    assert.equal((await view(stranger.accessToken)).statusCode, 404);
    assert.equal((await power(stranger.accessToken)).statusCode, 404);
  });
});
