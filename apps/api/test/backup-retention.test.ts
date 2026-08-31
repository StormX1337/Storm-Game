import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { writeSettings, DEFAULT_SETTINGS } from '@storm/database';
import { applyBackupRetention } from '../src/workers/maintenance.worker.js';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Backup retention, and which of the two settings named after it actually runs.
 *
 * Admin → Settings → Backups → Retention had no reader anywhere in the API. An
 * administrator could set thirty days and watch backups pile up forever, while
 * the retention that did run lived on each backup storage under the same name.
 * It is now the panel-wide default for storages that have not set their own.
 */
describe('backup retention', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let customer: RegisteredUser;
  let storageId: string;
  let serverId: string;
  let nodeId: string;
  const createdUsers: string[] = [];

  const daysAgo = (days: number) => new Date(Date.now() - days * 86400 * 1000);

  async function makeBackup(ageDays: number, locked = false): Promise<string> {
    const backup = await app.prisma.backup.create({
      data: {
        serverId,
        storageId,
        name: `backup from ${ageDays} days ago`,
        status: 'COMPLETED',
        bytes: BigInt(1024),
        isLocked: locked,
        completedAt: daysAgo(ageDays),
        createdAt: daysAgo(ageDays),
      },
    });
    return backup.id;
  }

  const exists = async (id: string): Promise<boolean> =>
    (await app.prisma.backup.findUnique({ where: { id } })) !== null;

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    customer = await registerUser(app);
    createdUsers.push(customer.id);
    const suffix = uniqueSuffix();

    const node = await app.prisma.node.create({
      data: {
        name: `retention-node-${suffix}`,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        scheme: 'http',
        memoryTotal: 4096,
        diskTotal: 20480,
      },
    });
    nodeId = node.id;

    const template = await app.prisma.gameTemplate.findFirstOrThrow({
      where: { slug: 'minecraft-java' },
    });
    const server = await app.prisma.server.create({
      data: {
        name: 'Retention server',
        shortId: uniqueSuffix().slice(0, 8),
        ownerId: customer.id,
        nodeId,
        templateId: template.id,
        dockerImage: 'alpine',
        startupCommand: 'true',
        sftpUsername: `retention_${suffix}`,
        sftpPasswordEnc: 'not-a-real-secret',
      },
    });
    serverId = server.id;

    // Its own storage, so the suite never prunes anything real.
    const storage = await app.prisma.backupStorage.create({
      data: {
        name: `retention-storage-${suffix}`,
        driver: 'LOCAL',
        // No retention of its own: this is the case the panel setting covers.
        retentionDays: 0,
      },
    });
    storageId = storage.id;
  });

  beforeEach(async () => {
    await app.prisma.backup.deleteMany({ where: { storageId } });
  });

  after(async () => {
    await writeSettings(app.prisma, {
      backupRetentionDays: DEFAULT_SETTINGS.backupRetentionDays,
    });
    app.settings.invalidate();
    await app.prisma.backup.deleteMany({ where: { storageId } });
    await app.prisma.backupStorage.delete({ where: { id: storageId } }).catch(() => undefined);
    await app.prisma.server.deleteMany({ where: { nodeId } });
    await app.prisma.node.delete({ where: { id: nodeId } }).catch(() => undefined);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  async function setPanelRetention(days: number): Promise<void> {
    await writeSettings(app.prisma, { backupRetentionDays: days });
    app.settings.invalidate();
  }

  it('prunes by the panel setting when a storage has none of its own', async () => {
    await setPanelRetention(30);
    const old = await makeBackup(45);
    const recent = await makeBackup(5);

    await applyBackupRetention(app);

    assert.equal(await exists(old), false, '45 days old, past a 30 day policy');
    assert.equal(await exists(recent), true, '5 days old, well inside it');
  });

  it("lets a storage's own retention win over the panel default", async () => {
    await setPanelRetention(30);
    await app.prisma.backupStorage.update({
      where: { id: storageId },
      data: { retentionDays: 90 },
    });

    const middle = await makeBackup(45);
    await applyBackupRetention(app);
    assert.equal(
      await exists(middle),
      true,
      'the storage says 90 days, so a 45 day old backup stays',
    );

    await app.prisma.backupStorage.update({
      where: { id: storageId },
      data: { retentionDays: 0 },
    });
  });

  it('keeps everything forever when both are zero', async () => {
    await setPanelRetention(0);
    const ancient = await makeBackup(4000);

    await applyBackupRetention(app);

    assert.equal(
      await exists(ancient),
      true,
      'zero means keep forever, which is what the settings page promises',
    );
  });

  it('never prunes a locked backup, however old', async () => {
    await setPanelRetention(30);
    const locked = await makeBackup(4000, true);

    await applyBackupRetention(app);

    assert.equal(await exists(locked), true, 'locking a backup is the whole point of the flag');
  });
});
