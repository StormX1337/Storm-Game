import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { list as listTar } from 'tar';
import { BackupService } from '../src/services/backup.service.js';
import { ServerPaths } from '../src/lib/paths.js';

const UUID = '99999999-8888-7777-6666-555555555555';
const BACKUP = '11112222-3333-4444-5555-666677778888';

const log = {
  child: () => log,
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
} as never;

/**
 * Making a backup archive and putting it back.
 *
 * The panel's half of this is tested; the agent's half — the part that
 * actually packs the tar and unpacks it over a live server directory — was
 * not. It is the one operation in the panel where being wrong is
 * unrecoverable: everything else can be done again, but a restore that eats
 * the world it was supposed to put back is discovered exactly once, by
 * somebody who needed it.
 */
async function scratch(): Promise<{
  backups: BackupService;
  root: string;
  backupDirectory: string;
}> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'storm-backup-'));
  const data = path.join(base, 'data');
  const backupDirectory = path.join(base, 'backups');
  const root = path.join(data, UUID);
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(backupDirectory, { recursive: true });

  return {
    backups: new BackupService({
      backupDirectory,
      paths: new ServerPaths(data),
      logger: log,
    }),
    root,
    backupDirectory,
  };
}

/** Everything the archive holds, as paths. */
async function entriesIn(archive: string): Promise<string[]> {
  const found: string[] = [];
  await listTar({ file: archive, onentry: (entry) => found.push(String(entry.path)) });
  return found.map((entry) => entry.replace(/^\.\//, '')).sort();
}

const exists = (target: string): Promise<boolean> =>
  fs
    .access(target)
    .then(() => true)
    .catch(() => false);

test('backing a server up and putting it back', async (t) => {
  await t.test('archives the server directory, and says what it made', async () => {
    const { backups, root, backupDirectory } = await scratch();
    await fs.writeFile(path.join(root, 'server.properties'), 'motd=hello\n');
    await fs.mkdir(path.join(root, 'world'), { recursive: true });
    await fs.writeFile(path.join(root, 'world', 'level.dat'), 'terrain');

    const result = await backups.create({ uuid: UUID, backupUuid: BACKUP, ignore: [] });

    assert.equal(result.backupUuid, BACKUP);
    assert.equal(result.checksumType, 'sha256');
    assert.match(result.checksum, /^[0-9a-f]{64}$/);
    assert.ok(result.bytes > 0);

    const archive = path.join(backupDirectory, UUID, `${BACKUP}.tar.gz`);
    const held = await entriesIn(archive);
    assert.ok(held.includes('server.properties'), held.join(','));
    assert.ok(held.includes('world/level.dat'), held.join(','));
  });

  await t.test('leaves out what the customer asked to leave out', async () => {
    const { backups, root, backupDirectory } = await scratch();
    await fs.writeFile(path.join(root, 'keep.txt'), 'keep');
    await fs.mkdir(path.join(root, 'dynmap'), { recursive: true });
    await fs.writeFile(path.join(root, 'dynmap', 'tiles.png'), 'huge');

    await backups.create({ uuid: UUID, backupUuid: BACKUP, ignore: ['dynmap'] });

    const held = await entriesIn(path.join(backupDirectory, UUID, `${BACKUP}.tar.gz`));
    assert.ok(held.includes('keep.txt'), held.join(','));
    assert.ok(
      !held.some((entry) => entry.startsWith('dynmap')),
      `the excluded folder was archived anyway: ${held.join(',')}`,
    );
  });

  await t.test('honours a glob, not just an exact name', async () => {
    const { backups, root, backupDirectory } = await scratch();
    await fs.writeFile(path.join(root, 'keep.txt'), 'keep');
    await fs.mkdir(path.join(root, 'logs'), { recursive: true });
    await fs.writeFile(path.join(root, 'logs', 'latest.log'), 'noise');
    await fs.writeFile(path.join(root, 'logs', 'debug.log'), 'noise');

    await backups.create({ uuid: UUID, backupUuid: BACKUP, ignore: ['logs/*.log'] });

    const held = await entriesIn(path.join(backupDirectory, UUID, `${BACKUP}.tar.gz`));
    assert.ok(held.includes('keep.txt'), held.join(','));
    assert.ok(
      !held.some((entry) => entry.endsWith('.log')),
      `a glob did not exclude anything: ${held.join(',')}`,
    );
  });

  await t.test('never archives the agent’s own scratch directory', async () => {
    const { backups, root, backupDirectory } = await scratch();
    await fs.writeFile(path.join(root, 'keep.txt'), 'keep');
    await fs.mkdir(path.join(root, '.storm'), { recursive: true });
    await fs.writeFile(path.join(root, '.storm', 'notes'), 'internal');

    await backups.create({ uuid: UUID, backupUuid: BACKUP, ignore: [] });

    const held = await entriesIn(path.join(backupDirectory, UUID, `${BACKUP}.tar.gz`));
    assert.ok(!held.some((entry) => entry.startsWith('.storm')), held.join(','));
  });

  /* ------------------------------------------------------ putting it back -- */

  await t.test('puts back exactly what it took', async () => {
    const { backups, root } = await scratch();
    await fs.writeFile(path.join(root, 'server.properties'), 'motd=original\n');
    await fs.mkdir(path.join(root, 'world'), { recursive: true });
    await fs.writeFile(path.join(root, 'world', 'level.dat'), 'terrain');

    await backups.create({ uuid: UUID, backupUuid: BACKUP, ignore: [] });
    await fs.writeFile(path.join(root, 'server.properties'), 'motd=broken\n');
    await fs.rm(path.join(root, 'world'), { recursive: true, force: true });

    await backups.restore({ uuid: UUID, backupUuid: BACKUP, truncate: false });

    assert.equal(
      await fs.readFile(path.join(root, 'server.properties'), 'utf8'),
      'motd=original\n',
    );
    assert.equal(await fs.readFile(path.join(root, 'world', 'level.dat'), 'utf8'), 'terrain');
  });

  await t.test('a truncating restore clears what the archive does not carry', async () => {
    const { backups, root } = await scratch();
    await fs.writeFile(path.join(root, 'keep.txt'), 'in the backup');

    await backups.create({ uuid: UUID, backupUuid: BACKUP, ignore: [] });
    await fs.writeFile(path.join(root, 'added-later.txt'), 'not in the backup');

    await backups.restore({ uuid: UUID, backupUuid: BACKUP, truncate: true });

    assert.equal(await fs.readFile(path.join(root, 'keep.txt'), 'utf8'), 'in the backup');
    assert.equal(await exists(path.join(root, 'added-later.txt')), false);
  });

  await t.test('keeps the directory itself, which is a live bind mount', async () => {
    const { backups, root } = await scratch();
    await fs.writeFile(path.join(root, 'keep.txt'), 'x');
    await backups.create({ uuid: UUID, backupUuid: BACKUP, ignore: [] });

    const before = await fs.stat(root);
    await backups.restore({ uuid: UUID, backupUuid: BACKUP, truncate: true });
    const after = await fs.stat(root);

    assert.equal(after.ino, before.ino, 'the data directory was replaced, not emptied');
  });

  /* ------------------------------------------- when the archive is no good -- */

  await t.test('does not wipe the server for an archive it cannot read', async () => {
    // The order used to be: empty the directory, then try to extract. So a
    // truncated download, a half-written file, or simply the wrong bytes took
    // the live world with it and left nothing to put back — during the one
    // operation somebody reaches for when something has already gone wrong.
    const { backups, root, backupDirectory } = await scratch();
    await fs.writeFile(path.join(root, 'world.dat'), 'the only copy');

    await fs.mkdir(path.join(backupDirectory, UUID), { recursive: true });
    await fs.writeFile(
      path.join(backupDirectory, UUID, `${BACKUP}.tar.gz`),
      'this is not a tar archive at all',
    );

    await assert.rejects(backups.restore({ uuid: UUID, backupUuid: BACKUP, truncate: true }));

    assert.equal(
      await fs.readFile(path.join(root, 'world.dat'), 'utf8'),
      'the only copy',
      'a restore that could not run deleted the data it was meant to replace',
    );
  });

  await t.test('does not wipe the server for an archive that is cut short', async () => {
    // The likelier shape of the same thing: a real archive whose download was
    // interrupted. The header reads fine; the end of it is missing.
    const { backups, root, backupDirectory } = await scratch();
    await fs.mkdir(path.join(root, 'world'), { recursive: true });
    for (let index = 0; index < 200; index += 1) {
      await fs.writeFile(path.join(root, 'world', `r.${index}.mca`), 'x'.repeat(4096));
    }
    await backups.create({ uuid: UUID, backupUuid: BACKUP, ignore: [] });

    const archive = path.join(backupDirectory, UUID, `${BACKUP}.tar.gz`);
    const whole = await fs.readFile(archive);
    await fs.writeFile(archive, whole.subarray(0, Math.floor(whole.length / 2)));

    await assert.rejects(backups.restore({ uuid: UUID, backupUuid: BACKUP, truncate: true }));
    assert.ok(
      (await fs.readdir(path.join(root, 'world'))).length > 0,
      'a half-downloaded archive emptied the world it was restoring',
    );
  });

  await t.test('checks the archive against the checksum the panel recorded', async () => {
    // The panel has computed and stored a sha256 for every archive since the
    // first release, and never once read it back. A whole, well-formed archive
    // can still be the wrong one, or the right one with a block rotted out of
    // it in object storage — and neither reads as corrupt to tar.
    const { backups, root } = await scratch();
    await fs.writeFile(path.join(root, 'world.dat'), 'the only copy');
    const made = await backups.create({ uuid: UUID, backupUuid: BACKUP, ignore: [] });

    await assert.rejects(
      backups.restore({
        uuid: UUID,
        backupUuid: BACKUP,
        truncate: true,
        checksum: 'f'.repeat(64),
      }),
      /checksum/i,
    );
    assert.equal(
      await fs.readFile(path.join(root, 'world.dat'), 'utf8'),
      'the only copy',
      'restored an archive that was not the one the panel recorded',
    );

    // And the real one still goes through.
    await backups.restore({
      uuid: UUID,
      backupUuid: BACKUP,
      truncate: true,
      checksum: made.checksum,
    });
    assert.equal(await fs.readFile(path.join(root, 'world.dat'), 'utf8'), 'the only copy');
  });

  await t.test('still restores an archive taken before checksums were sent', async () => {
    // Every backup already on a customer's node predates this. Refusing them
    // would turn a safety check into an outage.
    const { backups, root } = await scratch();
    await fs.writeFile(path.join(root, 'world.dat'), 'older than the check');
    await backups.create({ uuid: UUID, backupUuid: BACKUP, ignore: [] });
    await fs.rm(path.join(root, 'world.dat'));

    await backups.restore({ uuid: UUID, backupUuid: BACKUP, truncate: false });

    assert.equal(await fs.readFile(path.join(root, 'world.dat'), 'utf8'), 'older than the check');
  });

  await t.test('says so plainly when there is no archive at all', async () => {
    const { backups, root } = await scratch();
    await fs.writeFile(path.join(root, 'world.dat'), 'the only copy');

    await assert.rejects(
      backups.restore({ uuid: UUID, backupUuid: BACKUP, truncate: true }),
      /not available/i,
    );
    assert.equal(await fs.readFile(path.join(root, 'world.dat'), 'utf8'), 'the only copy');
  });
});

/**
 * What is left on the node once a server is deleted.
 *
 * `removeRoot` takes the server directory. Archives are not in it — they are
 * in `backupDirectory/<uuid>/`, deliberately, so a `truncate` restore cannot
 * eat the thing it is restoring from. Which means deleting a server left its
 * entire backup history on the disk, full size, with the panel's rows
 * cascaded away in the same breath: nothing on either side could name those
 * files again.
 */
test('deleting a server takes its archives with it', async (t) => {
  await t.test('removes every archive the server had on this node', async () => {
    const { backups, root, backupDirectory } = await scratch();
    await fs.writeFile(path.join(root, 'world.dat'), 'terrain');
    await backups.create({ uuid: UUID, backupUuid: BACKUP, ignore: [] });
    const other = '00001111-2222-3333-4444-555566667777';
    await backups.create({ uuid: UUID, backupUuid: other, ignore: [] });

    await backups.removeAll(UUID);

    assert.equal(await exists(path.join(backupDirectory, UUID)), false);
  });

  await t.test('leaves other servers’ archives alone', async () => {
    const { backups, root, backupDirectory } = await scratch();
    await fs.writeFile(path.join(root, 'world.dat'), 'terrain');
    await backups.create({ uuid: UUID, backupUuid: BACKUP, ignore: [] });

    const neighbour = '12121212-3434-5656-7878-909090909090';
    const kept = path.join(backupDirectory, neighbour, `${BACKUP}.tar.gz`);
    await fs.mkdir(path.dirname(kept), { recursive: true });
    await fs.writeFile(kept, 'somebody else’s only copy');

    await backups.removeAll(UUID);

    assert.equal(await exists(kept), true, 'a deletion reached into another server’s backups');
  });

  await t.test('does not mind a server that never had a backup', async () => {
    const { backups } = await scratch();
    await backups.removeAll(UUID);
  });

  await t.test('cannot be talked into the directory above', async () => {
    // The route validates the uuid, so this is the second lock on the door
    // rather than the first — but the door it guards is every server's
    // archives at once, and a recursive delete has no undo.
    const { backups, root, backupDirectory } = await scratch();
    await fs.writeFile(path.join(root, 'world.dat'), 'terrain');
    await backups.create({ uuid: UUID, backupUuid: BACKUP, ignore: [] });

    // These name the backup root itself rather than escaping it, so they are
    // refused by being ignored.
    for (const attempt of ['', '.', '/', '../backups', 'x/..']) {
      await backups.removeAll(attempt);
    }
    // This one leaves the root, and is refused outright.
    await assert.rejects(backups.removeAll('../../data'), /outside|traversal|not allowed/i);

    assert.equal(
      await exists(path.join(backupDirectory, UUID, `${BACKUP}.tar.gz`)),
      true,
      'every server’s archives were deleted at once',
    );
    assert.equal(await exists(root), true, 'the delete reached outside the backup directory');
  });
});
