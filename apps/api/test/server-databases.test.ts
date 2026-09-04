import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@storm/database';
import { Permission, ServerStatus } from '@storm/types';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Databases a customer creates for their own server.
 *
 * The isolation tests cover the name validator — the part that stops a name
 * from closing a quote. What was never covered is everything around it: which
 * host a database is allowed to land on, who may read its password, and what
 * happens when the same one is asked for twice.
 *
 * The engines themselves are stubbed. What is under test is the panel's half:
 * it decides which host, holds the credentials, and is the only thing standing
 * between one tenant's database and another's.
 */
describe('server databases', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let owner: RegisteredUser;
  let stranger: RegisteredUser;
  let serverId: string;
  let ownNodeId: string;
  let otherNodeId: string;
  let ownHostId: string;
  let otherHostId: string;
  let sharedHostId: string;
  const createdUsers: string[] = [];

  let provisioned: { database: string; username: string }[] = [];
  let destroyed: { database: string; username: string }[] = [];
  let provisionFails = false;

  const asOwner = () => ({ authorization: `Bearer ${owner.accessToken}` });
  const asStranger = () => ({ authorization: `Bearer ${stranger.accessToken}` });

  const createDatabase = (payload: Record<string, unknown>, headers = asOwner()) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/databases`,
      headers,
      payload,
    });

  const listDatabases = (headers = asOwner()) =>
    app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/databases`, headers });

  async function makeHost(name: string, nodeId: string | null): Promise<string> {
    const host = await app.prisma.databaseHost.create({
      data: {
        name,
        engine: 'MYSQL',
        host: '127.0.0.1',
        port: 3306,
        username: 'root',
        passwordEnc: app.encrypter.encrypt('not-a-real-secret'),
        nodeId,
        isActive: true,
      },
    });
    return host.id;
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    // The engines are stubbed; what matters here is which host the panel picks
    // and what it hands back, not that MySQL agrees.
    app.databases.provision = (async (
      _host: unknown,
      database: string,
      username: string,
    ): Promise<void> => {
      if (provisionFails) throw new Error('the engine said no');
      provisioned.push({ database, username });
    }) as typeof app.databases.provision;

    app.databases.destroy = (async (
      _host: unknown,
      database: string,
      username: string,
    ): Promise<void> => {
      destroyed.push({ database, username });
    }) as typeof app.databases.destroy;

    app.databases.resetPassword = (async (): Promise<void> => undefined) as never;

    owner = await registerUser(app);
    stranger = await registerUser(app);
    createdUsers.push(owner.id, stranger.id);
    const suffix = uniqueSuffix();

    const nodeData = {
      location: 'Test',
      hostname: '127.0.0.1',
      ip: '127.0.0.1',
      scheme: 'http',
      memoryTotal: 8192,
      diskTotal: 51200,
      status: 'ONLINE' as const,
    };
    ownNodeId = (await app.prisma.node.create({ data: { name: `db-own-${suffix}`, ...nodeData } }))
      .id;
    otherNodeId = (
      await app.prisma.node.create({ data: { name: `db-other-${suffix}`, ...nodeData } })
    ).id;

    ownHostId = await makeHost(`host-own-${suffix}`, ownNodeId);
    otherHostId = await makeHost(`host-other-${suffix}`, otherNodeId);
    sharedHostId = await makeHost(`host-shared-${suffix}`, null);

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    const server = await app.prisma.server.create({
      data: {
        name: 'Databased',
        shortId: uniqueSuffix().slice(0, 8),
        ownerId: owner.id,
        nodeId: ownNodeId,
        templateId: template.id,
        dockerImage: 'alpine',
        startupCommand: 'true',
        sftpUsername: `db_${suffix}`,
        sftpPasswordEnc: 'not-a-real-secret',
        status: ServerStatus.OFFLINE,
        installedAt: new Date(),
      },
    });
    serverId = server.id;
  });

  after(async () => {
    await app.prisma.serverDatabase.deleteMany({ where: { serverId } });
    await app.prisma.databaseHost.deleteMany({
      where: { id: { in: [ownHostId, otherHostId, sharedHostId] } },
    });
    await app.prisma.server.deleteMany({ where: { nodeId: ownNodeId } });
    await app.prisma.node.deleteMany({ where: { id: { in: [ownNodeId, otherNodeId] } } });
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    provisioned = [];
    destroyed = [];
    provisionFails = false;
    await app.prisma.serverDatabase.deleteMany({ where: { serverId } });
    await app.prisma.user.update({ where: { id: owner.id }, data: { databaseLimit: 10 } });
  });

  /* ------------------------------------------------------ which host -- */

  it('creates a database on a host that serves the server’s own node', async () => {
    const response = await createDatabase({ name: 'survival' });
    assert.equal(response.statusCode, 201, response.body);

    const created = response.json<{ data: { name: string; password: string } }>().data;
    assert.match(created.name, /_survival$/);
    assert.ok(created.password.length >= 20, 'no password came back');
    assert.equal(provisioned.length, 1);
  });

  it('will not put a database on a host belonging to another node', async () => {
    // Which host a database lands on is the operator's decision — that is what
    // the node binding on a host is for. The unnamed case honours it; naming a
    // host explicitly skipped the check entirely, so a customer could place
    // their database on any active host on the panel, including one dedicated
    // to hardware they are not on.
    const response = await createDatabase({ name: 'elsewhere', hostId: otherHostId });

    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(provisioned, [], 'a database was created on the other node’s host');
  });

  it('allows a host that is not bound to any node, which is shared on purpose', async () => {
    const response = await createDatabase({ name: 'shared', hostId: sharedHostId });
    assert.equal(response.statusCode, 201, response.body);
  });

  it('allows naming the server’s own host explicitly', async () => {
    const response = await createDatabase({ name: 'explicit', hostId: ownHostId });
    assert.equal(response.statusCode, 201, response.body);
  });

  /* ------------------------------------------------- asking twice -- */

  it('refuses a name that is already taken', async () => {
    assert.equal((await createDatabase({ name: 'dupe' })).statusCode, 201);

    const second = await createDatabase({ name: 'dupe' });
    assert.equal(second.statusCode, 400, second.body);
  });

  it('a lost race does not drop the database the winner just made', async () => {
    // The duplicate check and the row write are two steps, and the panel runs
    // on more than one process. Two requests for one name can both pass the
    // check; only one can write the row. What the loser must not do is roll
    // back "its" database — by then the name belongs to the winner, and the
    // name is the only handle there is.
    //
    // Driven here by making the write fail the way the database makes it fail,
    // because two injected requests in one process do not actually interleave
    // at that point: the race is real across replicas, not reproducible from
    // a single one, and the error handler is what has to be right either way.
    const created = await createDatabase({ name: 'contested' });
    assert.equal(created.statusCode, 201, created.body);
    const name = created.json<{ data: { name: string } }>().data.name;
    destroyed = [];

    const original = app.prisma.serverDatabase.create;
    app.prisma.serverDatabase.create = (() => {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
    }) as typeof app.prisma.serverDatabase.create;

    try {
      const response = await createDatabase({ name: 'anything' });
      assert.equal(response.statusCode, 400, response.body);
      assert.deepEqual(destroyed, [], 'the loser dropped a database it did not own');
    } finally {
      app.prisma.serverDatabase.create = original;
    }

    const rows = await app.prisma.serverDatabase.findMany({ where: { serverId } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.databaseName, name);
  });

  it('cleans up after itself when the engine accepted but the panel could not record it', async () => {
    // The other direction: a database left on a host with no row pointing at
    // it is invisible to everybody and never cleaned up.
    provisionFails = false;
    const original = app.prisma.serverDatabase.create;
    app.prisma.serverDatabase.create = (() => {
      throw new Error('the panel could not write the row');
    }) as typeof app.prisma.serverDatabase.create;

    try {
      const response = await createDatabase({ name: 'orphan' });
      assert.equal(response.statusCode, 500, response.body);
      assert.equal(destroyed.length, 1, 'the database was left behind on the host');
    } finally {
      app.prisma.serverDatabase.create = original;
    }
  });

  /* ----------------------------------------------------- who may see -- */

  it('does not show one customer another customer’s databases', async () => {
    await createDatabase({ name: 'private' });

    const response = await listDatabases(asStranger());
    // 404, not 403: a server somebody cannot see must not be confirmed to exist.
    assert.equal(response.statusCode, 404, response.body);
  });

  it('does not hand over credentials to somebody who guessed the id', async () => {
    const created = await createDatabase({ name: 'secret' });
    const databaseId = created.json<{ data: { id: string } }>().data.id;

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/databases/${databaseId}/credentials`,
      headers: asStranger(),
    });
    assert.equal(response.statusCode, 404, response.body);
  });

  it('keeps the password out of the listing, and puts it in the credentials call', async () => {
    await createDatabase({ name: 'quiet' });

    const listed = await listDatabases();
    assert.equal(listed.statusCode, 200, listed.body);
    const rows = listed.json<{ data: { id: string; password?: string }[] }>().data;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.password, undefined, 'the listing carried the password');

    const credentials = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/databases/${rows[0]!.id}/credentials`,
      headers: asOwner(),
    });
    assert.equal(credentials.statusCode, 200, credentials.body);
    assert.ok(credentials.json<{ data: { password: string } }>().data.password);
  });

  it('writes down that the password was looked at', async () => {
    const created = await createDatabase({ name: 'audited' });
    const databaseId = created.json<{ data: { id: string } }>().data.id;
    await app.prisma.activityLog.deleteMany({ where: { serverId } });

    await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/databases/${databaseId}/credentials`,
      headers: asOwner(),
    });

    const entries = await app.prisma.activityLog.findMany({ where: { serverId } });
    assert.ok(
      entries.some((entry) => entry.event === 'database:credentials_viewed'),
      entries.map((entry) => entry.event).join(','),
    );
  });

  /* ---------------------------------------------------------- limits -- */

  it('stops at the number of databases the account was sold', async () => {
    await app.prisma.user.update({ where: { id: owner.id }, data: { databaseLimit: 1 } });
    assert.equal((await createDatabase({ name: 'first' })).statusCode, 201);

    const second = await createDatabase({ name: 'second' });
    assert.equal(second.statusCode, 409, second.body);
  });

  it('treats a limit of zero as unlimited, as every other limit does', async () => {
    await app.prisma.user.update({ where: { id: owner.id }, data: { databaseLimit: 0 } });

    assert.equal((await createDatabase({ name: 'one' })).statusCode, 201);
    assert.equal((await createDatabase({ name: 'two' })).statusCode, 201);
  });

  /* -------------------------------------------------------- removing -- */

  it('drops the database from the host as well as the panel', async () => {
    const created = await createDatabase({ name: 'goodbye' });
    const { id: databaseId, name } = created.json<{ data: { id: string; name: string } }>().data;

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${serverId}/databases/${databaseId}`,
      headers: asOwner(),
    });
    assert.equal(response.statusCode, 200, response.body);

    assert.deepEqual(
      destroyed.map((entry) => entry.database),
      [name],
    );
    assert.equal(await app.prisma.serverDatabase.count({ where: { serverId } }), 0);
  });

  it('will not let a share without the permission delete one', async () => {
    const created = await createDatabase({ name: 'shared' });
    const databaseId = created.json<{ data: { id: string } }>().data.id;

    await app.prisma.serverSubuser.create({
      data: {
        serverId,
        userId: stranger.id,
        permissions: [Permission.SERVERS_DATABASES],
      },
    });

    try {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/servers/${serverId}/databases/${databaseId}`,
        headers: asStranger(),
      });
      assert.equal(response.statusCode, 403, response.body);
      assert.deepEqual(destroyed, []);
    } finally {
      await app.prisma.serverSubuser.deleteMany({ where: { serverId } });
    }
  });
});
