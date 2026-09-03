import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Node } from '@storm/database';
import { hashPassword } from '@storm/security';
import { applyBackupRetention } from '../src/workers/maintenance.worker.js';
import {
  createTestApp,
  claimPanelStorage,
  deleteUser,
  registerUser,
  uniqueSuffix,
} from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Where an archive actually is, when the panel comes to delete it.
 *
 * With object storage it is in the bucket and the panel deletes it directly.
 * With the LOCAL driver it never left the node that made it, so the only way
 * to remove it is to ask that node — and the panel keeps no copy, whatever the
 * unused `BACKUP_LOCAL_PATH` on the API container used to suggest.
 *
 * Three places delete an archive and each carried that branch itself, which is
 * two places too many. The move worker did not carry it: it deleted from a
 * bucket that was not there, then deleted the row that knew where the file
 * was. Every bucketless move left a full copy of a server on the old node with
 * nothing left pointing at it.
 */
describe('deleting a backup archive', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let releaseStorage: () => Promise<void>;
  let customer: RegisteredUser;
  let localStorageId: string;
  let sharedStorageId: string;
  let serverId: string;
  let serverUuid: string;
  let serverShortId: string;
  let nodeId: string;
  let nodeName: string;
  const createdUsers: string[] = [];

  /** Every agent call the panel made, so a missing one is visible. */
  let calls: { node: string; path: string; method: string }[] = [];
  let agentFails = false;

  async function makeBackup(storageId: string, ageDays = 0): Promise<{ id: string; uuid: string }> {
    const at = new Date(Date.now() - ageDays * 86400_000);
    const backup = await app.prisma.backup.create({
      data: {
        serverId,
        storageId,
        name: `archive ${uniqueSuffix().slice(0, 6)}`,
        status: 'COMPLETED',
        bytes: BigInt(2048),
        storageKey: `backups/${serverUuid}/placeholder.tar.gz`,
        completedAt: at,
        createdAt: at,
      },
    });
    return { id: backup.id, uuid: backup.uuid };
  }

  const deletions = () =>
    calls.filter((call) => call.method === 'DELETE' && /\/backups\/[^/]+$/.test(call.path));

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;
    releaseStorage = await claimPanelStorage(app);

    // Recorded rather than sent: what is being tested is which of these the
    // panel makes, and a real one would reach a developer's node.
    app.agents.request = (async (node: Node, path: string, options?: { method?: string }) => {
      calls.push({ node: node.name, path, method: options?.method ?? 'GET' });
      if (agentFails) throw new Error('the node is not answering');
      return {};
    }) as typeof app.agents.request;

    customer = await registerUser(app);
    createdUsers.push(customer.id);

    const suffix = uniqueSuffix();
    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const owner = await app.prisma.user.create({
      data: {
        email: `arch-owner-${suffix}@storm.test`,
        username: `archowner${suffix}`,
        passwordHash: await hashPassword('OwnerPassword123!'),
        roleId: ownerRole.id,
        emailVerifiedAt: new Date(),
      },
    });
    createdUsers.push(owner.id);

    const node = await app.prisma.node.create({
      data: {
        name: `arch-node-${suffix}`,
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
    nodeName = node.name;

    localStorageId = (
      await app.prisma.backupStorage.create({
        data: { name: `arch-local-${suffix}`, driver: 'LOCAL', isActive: true, retentionDays: 0 },
      })
    ).id;
    sharedStorageId = (
      await app.prisma.backupStorage.create({
        data: {
          name: `arch-shared-${suffix}`,
          driver: 'S3',
          bucket: 'storm-test',
          region: 'auto',
          endpoint: 'http://127.0.0.1:9000',
          accessKeyEnc: app.encrypter.encrypt('test-access-key'),
          secretKeyEnc: app.encrypter.encrypt('test-secret-key'),
          isActive: false,
          retentionDays: 0,
        },
      })
    ).id;

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    const server = await app.prisma.server.create({
      data: {
        name: 'Archived server',
        shortId: uniqueSuffix().slice(0, 8),
        ownerId: customer.id,
        nodeId,
        templateId: template.id,
        dockerImage: 'alpine',
        startupCommand: 'true',
        sftpUsername: `arch_${suffix}`,
        sftpPasswordEnc: 'not-a-real-secret',
        status: 'OFFLINE',
      },
    });
    serverId = server.id;
    serverUuid = server.uuid;
    serverShortId = server.shortId;
  });

  after(async () => {
    await app.prisma.backup.deleteMany({ where: { serverId } });
    await app.prisma.backupStorage.deleteMany({
      where: { id: { in: [localStorageId, sharedStorageId] } },
    });
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await releaseStorage();
    await cleanup();
  });

  beforeEach(async () => {
    calls = [];
    agentFails = false;
    await app.prisma.backup.deleteMany({ where: { serverId } });
  });

  /* ------------------------------------------------------- by hand -- */

  it('asks the node to delete a local archive', async () => {
    const backup = await makeBackup(localStorageId);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${serverShortId}/backups/${backup.id}`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
    });
    assert.equal(response.statusCode, 200, response.body);

    assert.equal(deletions().length, 1, JSON.stringify(calls));
    assert.equal(deletions()[0]?.node, nodeName);
    assert.match(
      deletions()[0]?.path ?? '',
      new RegExp(`/servers/${serverUuid}/backups/${backup.uuid}$`),
    );
  });

  it('does not ask the node about an archive that is in a bucket', async () => {
    const backup = await makeBackup(sharedStorageId);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${serverShortId}/backups/${backup.id}`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(deletions(), [], 'sent a node a delete for a file it never had');
  });

  it('forgets the backup even when the node cannot be reached', async () => {
    // Deleting by hand is a request somebody is waiting on. An unreachable
    // node is logged and the record goes: leaving it would mean the button
    // does nothing until the node comes back.
    const backup = await makeBackup(localStorageId);
    agentFails = true;

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${serverShortId}/backups/${backup.id}`,
      headers: { authorization: `Bearer ${customer.accessToken}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await app.prisma.backup.count({ where: { id: backup.id } }), 0);
  });

  /* ----------------------------------------------------- retention -- */

  it('asks the node when retention prunes a local archive', async () => {
    await app.prisma.backupStorage.update({
      where: { id: localStorageId },
      data: { retentionDays: 7 },
    });
    const backup = await makeBackup(localStorageId, 30);

    try {
      await applyBackupRetention(app);
      assert.equal(deletions().length, 1, JSON.stringify(calls));
      assert.equal(await app.prisma.backup.count({ where: { id: backup.id } }), 0);
    } finally {
      await app.prisma.backupStorage.update({
        where: { id: localStorageId },
        data: { retentionDays: 0 },
      });
    }
  });

  it('keeps the record when the archive could not be pruned', async () => {
    // The opposite call to the one above: nobody is waiting on retention, so
    // forgetting a file the node still holds would orphan it forever. The row
    // stays and the next run tries again.
    await app.prisma.backupStorage.update({
      where: { id: localStorageId },
      data: { retentionDays: 7 },
    });
    const backup = await makeBackup(localStorageId, 30);
    agentFails = true;

    try {
      await applyBackupRetention(app);
      assert.equal(
        await app.prisma.backup.count({ where: { id: backup.id } }),
        1,
        'forgot an archive the node still has',
      );

      agentFails = false;
      await applyBackupRetention(app);
      assert.equal(await app.prisma.backup.count({ where: { id: backup.id } }), 0);
    } finally {
      await app.prisma.backupStorage.update({
        where: { id: localStorageId },
        data: { retentionDays: 0 },
      });
    }
  });
});
