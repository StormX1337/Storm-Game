import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Node } from '@storm/database';
import { BackupStatus, NotificationType, ServerStatus, WebhookEvent } from '@storm/types';
import { runBackup, runRestore } from '../src/workers/backup.worker.js';
import {
  claimPanelStorage,
  createTestApp,
  deleteUser,
  registerUser,
  uniqueSuffix,
} from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * The whole way round: take a backup, then put it back.
 *
 * This is the one feature where being wrong is unrecoverable. Everything else
 * the panel does can be done again — a server reinstalled, a port reassigned —
 * but a backup that turns out not to restore is discovered exactly once, by
 * somebody who needed it.
 *
 * The workers behind it had no test of their own. What is pinned here is the
 * bookkeeping either side of the agent call: what the panel tells the node to
 * do, what it writes down afterwards, and — the part that matters when it goes
 * wrong — that a failed restore leaves the record saying what it said before,
 * rather than a server stuck in RESTORING with nothing coming.
 */
describe('taking a backup and putting it back', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let releaseStorage: () => Promise<void>;
  let customer: RegisteredUser;
  let storageId: string;
  let serverId: string;
  let serverUuid: string;
  let nodeId: string;
  const createdUsers: string[] = [];

  let calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  let agentFails: string | null = null;
  let agentResult: { bytes: number; checksum: string } = { bytes: 4096, checksum: 'deadbeef' };

  async function makeBackup(data: Record<string, unknown> = {}): Promise<string> {
    const backup = await app.prisma.backup.create({
      data: {
        serverId,
        storageId,
        name: `nightly ${uniqueSuffix().slice(0, 6)}`,
        ...data,
      },
    });
    return backup.id;
  }

  const read = (id: string) => app.prisma.backup.findUniqueOrThrow({ where: { id } });
  const notifications = () =>
    app.prisma.notification.findMany({
      where: { userId: customer.id },
      orderBy: { createdAt: 'asc' },
    });

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;
    releaseStorage = await claimPanelStorage(app);

    // The node is stubbed; what is under test is everything either side of it.
    app.agents.request = (async (
      _node: Node,
      path: string,
      options?: { method?: string; body?: Record<string, unknown> },
    ) => {
      calls.push({ path, method: options?.method ?? 'GET', body: options?.body ?? {} });
      if (agentFails) throw new Error(agentFails);
      return agentResult;
    }) as typeof app.agents.request;

    customer = await registerUser(app);
    createdUsers.push(customer.id);
    const suffix = uniqueSuffix();

    const node = await app.prisma.node.create({
      data: {
        name: `life-node-${suffix}`,
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

    storageId = (
      await app.prisma.backupStorage.create({
        data: { name: `life-local-${suffix}`, driver: 'LOCAL', isActive: true, retentionDays: 0 },
      })
    ).id;

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    const server = await app.prisma.server.create({
      data: {
        name: 'Survival',
        shortId: uniqueSuffix().slice(0, 8),
        ownerId: customer.id,
        nodeId,
        templateId: template.id,
        dockerImage: 'alpine',
        startupCommand: 'true',
        sftpUsername: `life_${suffix}`,
        sftpPasswordEnc: 'not-a-real-secret',
        status: ServerStatus.OFFLINE,
      },
    });
    serverId = server.id;
    serverUuid = server.uuid;
  });

  after(async () => {
    await app.prisma.backup.deleteMany({ where: { serverId } });
    await app.prisma.backupStorage.delete({ where: { id: storageId } }).catch(() => undefined);
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await releaseStorage();
    await cleanup();
  });

  beforeEach(async () => {
    calls = [];
    agentFails = null;
    agentResult = { bytes: 4096, checksum: 'deadbeef' };
    await app.prisma.backup.deleteMany({ where: { serverId } });
    await app.prisma.notification.deleteMany({ where: { userId: customer.id } });
  });

  /* ------------------------------------------------------------ taking -- */

  it('tells the node what to archive, and writes down what came back', async () => {
    const id = await makeBackup({ ignoredFiles: ['cache/', 'logs/*.gz'] });
    await runBackup(app, { backupId: id });

    const call = calls.find((entry) => entry.path.endsWith('/backups'));
    assert.ok(call, JSON.stringify(calls));
    assert.equal(call.method, 'POST');
    assert.equal(call.body.uuid, serverUuid);
    // What the customer asked to leave out has to reach the node, or the
    // archive quietly includes the world's worth of cache they excluded.
    assert.deepEqual(call.body.ignore, ['cache/', 'logs/*.gz']);

    const after = await read(id);
    assert.equal(after.status, BackupStatus.COMPLETED);
    assert.equal(after.bytes, 4096n);
    assert.equal(after.checksum, 'deadbeef');
    assert.ok(after.storageKey, 'nothing recorded where the archive went');
    assert.ok(after.completedAt);
    assert.equal(after.error, null);
  });

  it('points the archive at this server and this backup, not another', async () => {
    // The key is what a restore reads back. Getting it wrong restores somebody
    // else's world, which is worse than restoring nothing.
    const first = await makeBackup();
    const second = await makeBackup();
    await runBackup(app, { backupId: first });
    await runBackup(app, { backupId: second });

    const [a, b] = await Promise.all([read(first), read(second)]);
    assert.notEqual(a.storageKey, b.storageKey);
    assert.match(a.storageKey ?? '', new RegExp(`/${serverUuid}/${a.uuid}\\.tar\\.gz$`));
  });

  it('tells the owner it worked', async () => {
    const id = await makeBackup();
    await runBackup(app, { backupId: id });

    const [note] = await notifications();
    assert.equal(note?.type, NotificationType.BACKUP_COMPLETED);
    assert.match(note?.message ?? '', /Survival/);
  });

  it('records a failed backup as failed, with the reason', async () => {
    // A backup that silently did not happen is the worst outcome here: the
    // list shows a row and nobody looks again until they need it.
    const id = await makeBackup();
    agentFails = 'no space left on device';

    await assert.rejects(runBackup(app, { backupId: id }));

    const after = await read(id);
    assert.equal(after.status, BackupStatus.FAILED);
    assert.match(after.error ?? '', /no space left/);
    assert.equal(after.completedAt, null);
    assert.equal(after.storageKey, null, 'recorded a key for an archive that was never written');

    const [note] = await notifications();
    assert.equal(note?.type, NotificationType.BACKUP_FAILED);
    assert.match(note?.message ?? '', /no space left/);
  });

  it('marks it running while the node is working', async () => {
    // Six hours is the timeout on this call. A row that still says PENDING
    // that whole time is a panel that looks like it lost the job.
    const id = await makeBackup();
    let seen: string | null = null;
    agentFails = null;
    app.agents.request = (async () => {
      seen = (await read(id)).status;
      return agentResult;
    }) as typeof app.agents.request;

    try {
      await runBackup(app, { backupId: id });
    } finally {
      app.agents.request = (async (
        _node: Node,
        path: string,
        options?: { method?: string; body?: Record<string, unknown> },
      ) => {
        calls.push({ path, method: options?.method ?? 'GET', body: options?.body ?? {} });
        if (agentFails) throw new Error(agentFails);
        return agentResult;
      }) as typeof app.agents.request;
    }

    assert.equal(seen, BackupStatus.RUNNING);
  });

  it('does nothing for a backup that has been deleted since it was queued', async () => {
    const id = await makeBackup();
    await app.prisma.backup.delete({ where: { id } });

    await runBackup(app, { backupId: id });
    assert.deepEqual(calls, [], 'archived a server for a record that no longer exists');
  });

  /* --------------------------------------------------------- putting back -- */

  it('hands the node the archive to restore, and what to do with the directory', async () => {
    const id = await makeBackup();
    await runBackup(app, { backupId: id });
    const stored = await read(id);
    calls = [];

    await runRestore(app, { backupId: id, truncate: true, userId: customer.id });

    const call = calls.find((entry) => entry.path.includes('/restore'));
    assert.ok(call, JSON.stringify(calls));
    assert.equal(call.body.truncate, true);
    assert.equal(call.body.backupUuid, stored.uuid);
    const download = call.body.download as { driver: string; key: string };
    assert.equal(download.driver, 'LOCAL');
    assert.equal(download.key, stored.storageKey);
  });

  it('leaves the backup where it started once the restore is done', async () => {
    const id = await makeBackup();
    await runBackup(app, { backupId: id });

    await runRestore(app, { backupId: id, truncate: false, userId: customer.id });

    const after = await read(id);
    assert.equal(after.status, BackupStatus.COMPLETED, 'left it stuck in RESTORING');
  });

  it('puts the status back when a restore fails, rather than stranding it', async () => {
    // The failure that matters. A backup left saying RESTORING can never be
    // restored again — the route refuses anything that is not COMPLETED — so
    // one bad attempt would take away the only copy they had.
    const id = await makeBackup();
    await runBackup(app, { backupId: id });
    agentFails = 'the archive is corrupt';

    await assert.rejects(runRestore(app, { backupId: id, truncate: false, userId: customer.id }));

    const after = await read(id);
    assert.equal(after.status, BackupStatus.COMPLETED, 'the backup can never be restored again');
    assert.match(after.error ?? '', /corrupt/);
  });

  it('tells the owner a restore failed', async () => {
    const id = await makeBackup();
    await runBackup(app, { backupId: id });
    await app.prisma.notification.deleteMany({ where: { userId: customer.id } });
    agentFails = 'the archive is corrupt';

    await assert.rejects(runRestore(app, { backupId: id, truncate: false, userId: customer.id }));

    const [note] = await notifications();
    assert.equal(note?.type, NotificationType.BACKUP_FAILED);
    assert.match(note?.title ?? '', /restore/i);
  });

  it('does not try to restore a backup with no archive behind it', async () => {
    const id = await makeBackup({ status: BackupStatus.FAILED });

    await runRestore(app, { backupId: id, truncate: false, userId: customer.id });
    assert.deepEqual(calls, [], 'asked a node to restore something that was never written');
  });

  /* ------------------------------------------------------------- events -- */

  it('raises the events a receiver is subscribed to', async () => {
    const raised: string[] = [];
    const realDispatch = app.webhooks.dispatch;
    app.webhooks.dispatch = (async (event: string) => {
      raised.push(event);
    }) as typeof realDispatch;

    try {
      const id = await makeBackup();
      await runBackup(app, { backupId: id });
      await runRestore(app, { backupId: id, truncate: false, userId: customer.id });
    } finally {
      app.webhooks.dispatch = realDispatch;
    }

    assert.deepEqual(raised, [WebhookEvent.BACKUP_COMPLETED, WebhookEvent.BACKUP_RESTORED]);
  });
});
