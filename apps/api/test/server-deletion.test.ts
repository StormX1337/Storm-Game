import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Permission, ServerStatus } from '@storm/types';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Deleting a server.
 *
 * The row went away and so did the container, and the panel called that done.
 * But a server is not only a container: it is also the MySQL database the
 * customer created for it and the backup archives that were taken of it, and
 * neither of those lives on the node the panel just wiped.
 *
 * Prisma cascades the *rows* — `ServerDatabase` and `Backup` both go with the
 * server. The things those rows point at are `onDelete: Restrict`, because
 * they are not ours to cascade: the database is on a shared host and the
 * archive is in a bucket or on a node's disk. So the deletion removed the
 * panel's only record of them and left them exactly where they were.
 *
 * The database is the sharp end. The credentials the customer copied out still
 * work, from anywhere (`remoteAccess` defaults to `%`), against a host that
 * other tenants also live on — and the panel no longer knows the database is
 * there to tell anyone about it.
 */
describe('deleting a server', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let owner: RegisteredUser;
  let nodeId: string;
  let hostId: string;
  let storageId: string;
  let serverId: string;
  let serverUuid: string;
  const createdUsers: string[] = [];

  let dropped: { database: string; username: string }[] = [];
  let removedArchives: string[] = [];
  /** Database names the stubbed engine refuses to drop. */
  let engineRefuses = new Set<string>();
  let storageRefuses = new Set<string>();
  let agentFails = false;

  const asOwner = () => ({ authorization: `Bearer ${owner.accessToken}` });

  const deleteServer = (payload: Record<string, unknown> = {}) =>
    app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${serverId}`,
      headers: asOwner(),
      payload,
    });

  const serverExists = async () =>
    (await app.prisma.server.count({ where: { id: serverId } })) === 1;

  async function makeDatabase(name: string): Promise<string> {
    const record = await app.prisma.serverDatabase.create({
      data: {
        serverId,
        hostId,
        databaseName: name,
        username: name,
        passwordEnc: app.encrypter.encrypt('not-a-real-secret'),
        remoteAccess: '%',
      },
    });
    return record.id;
  }

  async function makeBackup(key: string | null): Promise<string> {
    const backup = await app.prisma.backup.create({
      data: {
        serverId,
        storageId,
        name: `archive ${uniqueSuffix().slice(0, 6)}`,
        status: 'COMPLETED',
        storageKey: key,
      },
    });
    return backup.id;
  }

  const lastAudit = () =>
    app.prisma.auditLog.findFirst({
      where: { targetId: serverId, action: 'server.deleted' },
      orderBy: { createdAt: 'desc' },
    });

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    // The engine, the bucket and the node are all stubbed. What is under test
    // is whether the panel asks them at all.
    app.databases.destroy = (async (
      _host: unknown,
      database: string,
      username: string,
    ): Promise<void> => {
      if (engineRefuses.has(database)) throw new Error('the host is not answering');
      dropped.push({ database, username });
    }) as typeof app.databases.destroy;

    app.storage.removeArchive = (async (
      _storage: unknown,
      archive: { key: string },
    ): Promise<void> => {
      if (storageRefuses.has(archive.key)) throw new Error('the bucket said no');
      removedArchives.push(archive.key);
    }) as typeof app.storage.removeArchive;

    app.agents.request = (async () => {
      if (agentFails) throw new Error('the node is gone');
      return { deleted: true };
    }) as typeof app.agents.request;

    owner = await registerUser(app);
    createdUsers.push(owner.id);
    // Deleting a server is not a default customer permission.
    await app.prisma.user.update({
      where: { id: owner.id },
      data: { extraPermissions: [Permission.SERVERS_DELETE] },
    });

    const suffix = uniqueSuffix();
    nodeId = (
      await app.prisma.node.create({
        data: {
          name: `del-node-${suffix}`,
          location: 'Test',
          hostname: '127.0.0.1',
          ip: '127.0.0.1',
          scheme: 'http',
          memoryTotal: 8192,
          diskTotal: 51200,
          status: 'ONLINE',
        },
      })
    ).id;

    hostId = (
      await app.prisma.databaseHost.create({
        data: {
          name: `del-host-${suffix}`,
          engine: 'MYSQL',
          host: '127.0.0.1',
          port: 3306,
          username: 'root',
          passwordEnc: app.encrypter.encrypt('not-a-real-secret'),
          isActive: true,
        },
      })
    ).id;

    // Not active: another suite asserts on the panel-wide storage setup, and
    // this one only needs a row for its backups to point at.
    storageId = (
      await app.prisma.backupStorage.create({
        data: { name: `del-store-${suffix}`, driver: 'S3', bucket: 'b', isActive: false },
      })
    ).id;
  });

  after(async () => {
    await app.prisma.backup.deleteMany({ where: { server: { nodeId } } });
    await app.prisma.serverDatabase.deleteMany({ where: { server: { nodeId } } });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.backupStorage.delete({ where: { id: storageId } }).catch(() => undefined);
    await app.prisma.databaseHost.delete({ where: { id: hostId } }).catch(() => undefined);
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    dropped = [];
    removedArchives = [];
    engineRefuses = new Set();
    storageRefuses = new Set();
    agentFails = false;

    await app.prisma.backup.deleteMany({ where: { server: { nodeId } } });
    await app.prisma.serverDatabase.deleteMany({ where: { server: { nodeId } } });
    await app.prisma.server.deleteMany({ where: { nodeId } });

    const suffix = uniqueSuffix();
    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    const server = await app.prisma.server.create({
      data: {
        name: 'Being torn down',
        shortId: suffix.slice(0, 8),
        ownerId: owner.id,
        nodeId,
        templateId: template.id,
        dockerImage: 'alpine',
        startupCommand: 'true',
        sftpUsername: `del_${suffix}`,
        sftpPasswordEnc: app.encrypter.encrypt('not-a-real-secret'),
        status: ServerStatus.OFFLINE,
        installedAt: new Date(),
      },
    });
    serverId = server.id;
    serverUuid = server.uuid;
  });

  it('drops the databases the server owned off their host', async () => {
    // The row cascades away either way. The question is whether the database
    // itself does, or whether it stays live with credentials that still work.
    const name = `del${uniqueSuffix().slice(0, 10)}`;
    await makeDatabase(name);

    const response = await deleteServer();
    assert.equal(response.statusCode, 200, response.body);

    assert.deepEqual(
      dropped.map((entry) => entry.database),
      [name],
      'the customer’s database is still on the host, and the panel has forgotten it exists',
    );
  });

  it('removes the backup archives it is about to forget about', async () => {
    const first = `prefix/${serverUuid}/one.tar.gz`;
    const second = `prefix/${serverUuid}/two.tar.gz`;
    await makeBackup(first);
    await makeBackup(second);

    const response = await deleteServer();
    assert.equal(response.statusCode, 200, response.body);

    assert.deepEqual(
      removedArchives.sort(),
      [first, second].sort(),
      'the archives are still in storage with nothing left that knows where they are',
    );
  });

  it('leaves an unfinished backup alone when it never got as far as an archive', async () => {
    await makeBackup(null);

    const response = await deleteServer();
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(removedArchives, []);
  });

  it('refuses, and keeps the server, when a database could not be dropped', async () => {
    // Deleting the row anyway would orphan a live database on a shared host —
    // the same reason the route already refuses to orphan a running container.
    const name = `del${uniqueSuffix().slice(0, 10)}`;
    await makeDatabase(name);
    engineRefuses.add(name);

    const response = await deleteServer();
    assert.equal(response.statusCode, 503, response.body);
    assert.match(response.body, /force/i, 'the refusal does not say how to get past it');

    assert.ok(await serverExists(), 'the server was deleted even though its database survived');
    assert.equal(await app.prisma.serverDatabase.count({ where: { serverId } }), 1);
  });

  it('keeps the databases it did manage to drop when a later one fails', async () => {
    // Retrying the delete must not try to drop a database that is already
    // gone: the second attempt would fail on a name the host no longer knows.
    const gone = `dela${uniqueSuffix().slice(0, 9)}`;
    const stuck = `delb${uniqueSuffix().slice(0, 9)}`;
    await makeDatabase(gone);
    await makeDatabase(stuck);
    engineRefuses.add(stuck);

    assert.equal((await deleteServer()).statusCode, 503);

    const left = await app.prisma.serverDatabase.findMany({ where: { serverId } });
    assert.deepEqual(
      left.map((row) => row.databaseName),
      [stuck],
      'a database that was dropped is still recorded, so a retry would try again',
    );

    dropped = [];
    engineRefuses.clear();
    assert.equal((await deleteServer()).statusCode, 200);
    assert.deepEqual(
      dropped.map((entry) => entry.database),
      [stuck],
    );
  });

  it('goes through when forced, and writes down what it had to leave behind', async () => {
    const name = `del${uniqueSuffix().slice(0, 10)}`;
    await makeDatabase(name);
    engineRefuses.add(name);

    const response = await deleteServer({ force: true });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await serverExists(), false);

    const entry = await lastAudit();
    assert.ok(entry, 'the deletion was not written down');
    const metadata = entry.metadata as Record<string, unknown>;
    assert.deepEqual(
      metadata.databasesLeftBehind,
      [name],
      `nothing records the live database nobody will ever find: ${JSON.stringify(metadata)}`,
    );
  });

  it('does not let a stuck archive block the deletion, but says so', async () => {
    // An archive nobody can reach costs disk. It is not a way in, so it does
    // not get a veto over the deletion the way a live database does.
    const key = `prefix/${serverUuid}/stuck.tar.gz`;
    await makeBackup(key);
    storageRefuses.add(key);

    const response = await deleteServer();
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await serverExists(), false);

    const entry = await lastAudit();
    const metadata = entry?.metadata as Record<string, unknown>;
    assert.deepEqual(
      metadata?.archivesLeftBehind,
      [key],
      `nothing records the archive left in storage: ${JSON.stringify(metadata)}`,
    );
  });

  it('still refuses when the node cannot be reached', async () => {
    // The databases are already gone by this point — they are dropped first,
    // because that is the step that can refuse without having destroyed the
    // container. A refusal keeps the progress it made rather than unwinding
    // it: the caller asked for all of this to go away.
    const name = `del${uniqueSuffix().slice(0, 10)}`;
    await makeDatabase(name);
    agentFails = true;

    const response = await deleteServer();
    assert.equal(response.statusCode, 503, response.body);
    assert.ok(await serverExists());
    assert.equal(await app.prisma.serverDatabase.count({ where: { serverId } }), 0);
  });

  it('does not remove the archives when the node refuses the deletion', async () => {
    // A refused deletion is retried. The archives must still be there for the
    // retry to remove — and still be listed, so the panel knows to try.
    const key = `prefix/${serverUuid}/one.tar.gz`;
    await makeBackup(key);
    agentFails = true;

    assert.equal((await deleteServer()).statusCode, 503);

    assert.deepEqual(removedArchives, []);
    assert.equal(await app.prisma.backup.count({ where: { serverId } }), 1);
  });

  it('records what it cleaned up on an ordinary deletion', async () => {
    await makeDatabase(`del${uniqueSuffix().slice(0, 10)}`);
    await makeBackup(`prefix/${serverUuid}/one.tar.gz`);

    assert.equal((await deleteServer()).statusCode, 200);

    const metadata = (await lastAudit())?.metadata as Record<string, unknown>;
    assert.equal(metadata?.databasesDropped, 1);
    assert.equal(metadata?.archivesRemoved, 1);
  });
});
