import assert from 'node:assert/strict';
import { promises as fs, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import archiver from 'archiver';
import { FilesService } from '../src/services/files.service.js';
import { ServerPaths } from '../src/lib/paths.js';

const UUID = '11111111-2222-3333-4444-555555555555';

/**
 * The agent is the only component with real filesystem access, so this is
 * where a path bug becomes a customer reading somebody else's world — or the
 * host's `/etc`. `ServerPaths` and the primitives under it have tests; the
 * service that calls them did not, and it is the caller that decides which
 * check runs on which path.
 */
async function scratch(): Promise<{ files: FilesService; root: string; outside: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'storm-files-'));
  // The server directory lives under `data`, with `outside` as its sibling —
  // standing in for every other server on the node, and for the host itself.
  const data = path.join(base, 'data');
  const outside = path.join(base, 'outside');
  await fs.mkdir(path.join(data, UUID), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'secret.txt'), 'another customer\n');

  return { files: new FilesService(new ServerPaths(data)), root: path.join(data, UUID), outside };
}

/** Builds a zip from a list of entries, without going through the service. */
async function makeZip(
  target: string,
  entries: { name: string; content: string }[],
): Promise<void> {
  const output = createWriteStream(target);
  const archive = archiver('zip', { zlib: { level: 0 } });
  const done = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve());
    archive.on('error', reject);
    output.on('error', reject);
  });
  archive.pipe(output);
  for (const entry of entries) archive.append(entry.content, { name: entry.name });
  await archive.finalize();
  await done;
}

/**
 * Writes a zip by hand, because a library will not write a hostile one.
 *
 * `archiver` normalises `../` out of an entry name before it stores it, so an
 * archive built with it can never carry the attack — which makes it the wrong
 * tool for proving the extractor refuses one. A zip is a simple enough format
 * to emit directly: stored entries, one local header each, a central directory
 * and an end record.
 */
function rawZip(
  entries: { name: string; content: string }[],
  options: { declaredSize?: number } = {},
): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.content, 'utf8');
    const crc = crc32(data);
    // The compressed size has to be the truth or the reader cannot find the
    // next entry; the *uncompressed* size is a claim, and a hostile archive
    // is free to understate it.
    const declared = options.declaredSize ?? data.length;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(declared, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4); // version made by
    record.writeUInt16LE(20, 6); // version needed
    record.writeUInt16LE(0, 10); // stored
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(declared, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += header.length + name.length + data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...local, directory, end]);
}

const exists = (target: string): Promise<boolean> =>
  fs
    .access(target)
    .then(() => true)
    .catch(() => false);

test('the file manager stays inside the server directory', async (t) => {
  await t.test('refuses to read its way out with ..', async () => {
    const { files } = await scratch();
    await assert.rejects(files.read(UUID, '../../outside/secret.txt'), /outside the server/i);
  });

  await t.test('treats an absolute path as relative to the server root', async () => {
    const { files, root } = await scratch();
    await fs.mkdir(path.join(root, 'etc'), { recursive: true });
    await fs.writeFile(path.join(root, 'etc', 'passwd'), 'mine\n');

    // Not the host's /etc/passwd — the customer's own.
    assert.equal(await files.read(UUID, '/etc/passwd'), 'mine\n');
  });

  await t.test('refuses a path with a null byte', async () => {
    const { files } = await scratch();
    await assert.rejects(files.read(UUID, 'ok\0/bad'), /outside the server|null/i);
  });

  await t.test('will not follow a symlink out of the directory', async () => {
    const { files, root, outside } = await scratch();
    await fs.symlink(outside, path.join(root, 'escape'));

    await assert.rejects(files.read(UUID, 'escape/secret.txt'), /symlink|outside/i);
    await assert.rejects(files.write(UUID, 'escape/planted.txt', 'x'), /symlink|outside/i);
    assert.equal(await exists(path.join(outside, 'planted.txt')), false);
  });

  await t.test('lists a symlink as one rather than following it', async () => {
    const { files, root, outside } = await scratch();
    await fs.symlink(outside, path.join(root, 'escape'));

    const entries = await files.list(UUID, '/');
    const link = entries.find((entry) => entry.name === 'escape');
    assert.ok(link, JSON.stringify(entries));
    assert.equal(link.isSymlink, true);
  });

  await t.test('never walks into a symlink when searching', async () => {
    const { files, root, outside } = await scratch();
    await fs.symlink(outside, path.join(root, 'escape'));

    const hits = await files.search(UUID, '/', 'secret');
    assert.deepEqual(hits, [], 'the search reached through the symlink');
  });

  await t.test('refuses to delete the server root itself', async () => {
    const { files, root } = await scratch();
    await assert.rejects(files.remove(UUID, ['/']), /root cannot be deleted/i);
    assert.equal(await exists(root), true);
  });

  /* ------------------------------------------------------------ archives -- */

  await t.test('an archive entry cannot climb out of the server directory', async () => {
    const { files, root, outside } = await scratch();
    await fs.writeFile(
      path.join(root, 'evil.zip'),
      rawZip([{ name: '../../outside/planted.txt', content: 'owned' }]),
    );

    await files.decompress(UUID, '/', 'evil.zip');
    // Defanged rather than refused: `..` at the top of the server directory has
    // nowhere above it to go, so the entry lands harmlessly inside. What must
    // not happen is the file appearing next door.
    assert.equal(await exists(path.join(outside, 'planted.txt')), false);
    assert.equal(await exists(path.join(root, 'outside', 'planted.txt')), true);
  });

  await t.test('an archive entry cannot climb out of the folder it unpacks into', async () => {
    // Extracting into /plugins must stay in /plugins. Escaping to the server
    // root is not a break-in, but it is not what the customer asked for, and
    // it lets an archive overwrite files well outside the folder they chose.
    const { files, root } = await scratch();
    await fs.mkdir(path.join(root, 'plugins'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'plugins', 'evil.zip'),
      rawZip([{ name: '../server.properties', content: 'owned' }]),
    );

    await assert.rejects(
      files.decompress(UUID, '/plugins', 'evil.zip'),
      /escape the server directory/i,
    );
    assert.equal(await exists(path.join(root, 'server.properties')), false);
  });

  await t.test('refuses an archive entry that writes through a symlink', async () => {
    // The entry path is innocent — `escape/planted.txt` is inside the server
    // directory as a string. What it is not is inside it on disk: `escape` is
    // a link the customer planted earlier with their own file manager, and
    // writing "into" it writes wherever it points.
    const { files, root, outside } = await scratch();
    await fs.symlink(outside, path.join(root, 'escape'));
    await makeZip(path.join(root, 'evil.zip'), [{ name: 'escape/planted.txt', content: 'owned' }]);

    await assert.rejects(files.decompress(UUID, '/', 'evil.zip'), /symlink|outside|escape/i);
    assert.equal(
      await exists(path.join(outside, 'planted.txt')),
      false,
      'the archive wrote through the symlink and out of the server directory',
    );
  });

  await t.test('extracts an ordinary archive', async () => {
    // The control: refusing everything is not safety, it is a broken feature.
    const { files, root } = await scratch();
    await makeZip(path.join(root, 'good.zip'), [
      { name: 'plugins/config.yml', content: 'enabled: true\n' },
      { name: 'readme.txt', content: 'hello\n' },
    ]);

    assert.equal(await files.decompress(UUID, '/', 'good.zip'), 2);
    assert.equal(
      await fs.readFile(path.join(root, 'plugins', 'config.yml'), 'utf8'),
      'enabled: true\n',
    );
  });

  /* -------------------------------------------------- the node is shared -- */

  await t.test('will not unpack more than the disk budget allows', async () => {
    const { files, root } = await scratch();
    await makeZip(path.join(root, 'big.zip'), [{ name: 'world.dat', content: 'x'.repeat(4096) }]);

    await assert.rejects(files.decompress(UUID, '/', 'big.zip', 1024), /disk limit/i);
  });

  await t.test('refuses an oversized archive before writing any of it', async () => {
    // What the archive declares is checked first, so the ordinary bomb — the
    // one honest about its size — costs nothing at all to refuse. Writing four
    // kilobytes and then noticing is not the same thing.
    const { files, root } = await scratch();
    await fs.writeFile(
      path.join(root, 'huge.zip'),
      rawZip([{ name: 'world.dat', content: 'x' }], { declaredSize: 10 * 1024 * 1024 }),
    );

    await assert.rejects(files.decompress(UUID, '/', 'huge.zip', 1024), /disk limit/i);
    assert.equal(
      await exists(path.join(root, 'world.dat')),
      false,
      'the entry was opened before its declared size was checked',
    );
  });

  await t.test('refuses an archive with more files than a node can afford', async () => {
    // Empty files weigh nothing, so the byte budget never sees them coming —
    // but each one is an inode, and those run out first.
    const { files, root } = await scratch();
    await fs.writeFile(
      path.join(root, 'many.zip'),
      rawZip(Array.from({ length: 20_001 }, (_, index) => ({ name: `f${index}`, content: '' }))),
    );

    await assert.rejects(files.decompress(UUID, '/', 'many.zip'), /more than 20000 files/i);
    assert.equal(await exists(path.join(root, 'f0')), false);
  });

  await t.test('stops a bomb that lies about how big it is', async () => {
    // The size in a zip header is written by whoever built the archive. An
    // extractor that trusts it checks nothing at all: this entry declares one
    // byte and carries eight kilobytes.
    const { files, root } = await scratch();
    await fs.writeFile(
      path.join(root, 'liar.zip'),
      rawZip([{ name: 'bomb.dat', content: 'x'.repeat(8192) }], { declaredSize: 1 }),
    );

    await assert.rejects(files.decompress(UUID, '/', 'liar.zip', 1024), /disk limit/i);
    const written = await fs
      .stat(path.join(root, 'bomb.dat'))
      .then((stat) => stat.size)
      .catch(() => 0);
    assert.ok(written <= 1024 + 65536, `wrote ${written} bytes past a 1024-byte budget`);
  });

  await t.test('unpacks freely when the server has no disk limit', async () => {
    // 0 means unmetered, and the panel then sends no budget at all.
    const { files, root } = await scratch();
    await makeZip(path.join(root, 'big.zip'), [{ name: 'world.dat', content: 'x'.repeat(4096) }]);

    assert.equal(await files.decompress(UUID, '/', 'big.zip'), 1);
  });
});
