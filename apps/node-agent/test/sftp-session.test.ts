import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ssh2 from 'ssh2';
import { SftpService } from '../src/services/sftp.service.js';
import { ServerPaths } from '../src/lib/paths.js';
import type { PanelClient } from '../src/services/panel-client.js';

const UUID = '33333333-4444-5555-6666-777777777777';

const log = {
  child: () => log,
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
} as never;

/**
 * SFTP, driven over the wire by a real client.
 *
 * It is the same files as the file manager through a different door, and a
 * different implementation: its own path handling, its own handle table, its
 * own idea of what a read-only session may do. Only `openModeFor` had a test,
 * which is four lines of a four-hundred-line service — everything the protocol
 * actually does was unpinned.
 */
async function serve(options: { writable?: boolean } = {}): Promise<{
  sftp: ssh2.SFTPWrapper;
  root: string;
  outside: string;
  stop: () => Promise<void>;
}> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'storm-sftp-'));
  const data = path.join(base, 'data');
  const outside = path.join(base, 'outside');
  const root = path.join(data, UUID);
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'secret.txt'), 'another customer\n');

  const panel = {
    async authenticateSftp() {
      return { uuid: UUID, serverId: 'srv', writable: options.writable ?? true };
    },
  } as unknown as PanelClient;

  const service = new SftpService({
    port: 0,
    hostKeyPath: path.join(base, 'host.key'),
    paths: new ServerPaths(data),
    panel,
    logger: log,
  });
  await service.start();

  const client = new ssh2.Client();
  const sftp = await new Promise<ssh2.SFTPWrapper>((resolve, reject) => {
    client
      .on('ready', () => client.sftp((error, handle) => (error ? reject(error) : resolve(handle))))
      .on('error', reject)
      .connect({
        host: '127.0.0.1',
        port: service.boundPort,
        username: `${UUID}.abcd`,
        password: 'whatever-the-panel-said-yes-to',
      });
  });

  return {
    sftp,
    root,
    outside,
    stop: async () => {
      client.end();
      await service.stop();
    },
  };
}

/** Promisified helpers, because the ssh2 client is callback-shaped. */
const readdir = (sftp: ssh2.SFTPWrapper, at: string): Promise<ssh2.FileEntry[]> =>
  new Promise((resolve, reject) =>
    sftp.readdir(at, (error, list) => (error ? reject(error) : resolve(list))),
  );

const readFile = (sftp: ssh2.SFTPWrapper, at: string): Promise<string> =>
  new Promise((resolve, reject) =>
    sftp.readFile(at, (error, data) => (error ? reject(error) : resolve(data.toString('utf8')))),
  );

const writeFile = (sftp: ssh2.SFTPWrapper, at: string, content: string): Promise<void> =>
  new Promise((resolve, reject) =>
    sftp.writeFile(at, content, (error) => (error ? reject(error) : resolve())),
  );

const exists = (target: string): Promise<boolean> =>
  fs
    .access(target)
    .then(() => true)
    .catch(() => false);

test('an SFTP session is chrooted to its own server', async (t) => {
  await t.test('reads and writes an ordinary file', async () => {
    // The control: everything below refuses something, and a door that only
    // refuses is not a door.
    const { sftp, root, stop } = await serve();
    try {
      await fs.writeFile(path.join(root, 'server.properties'), 'motd=hello\n');
      assert.equal(await readFile(sftp, '/server.properties'), 'motd=hello\n');

      await writeFile(sftp, '/plugins/config.yml', 'enabled: true\n');
      assert.equal(
        await fs.readFile(path.join(root, 'plugins', 'config.yml'), 'utf8'),
        'enabled: true\n',
      );
    } finally {
      await stop();
    }
  });

  await t.test('refuses to read its way out with ..', async () => {
    const { sftp, stop } = await serve();
    try {
      await assert.rejects(readFile(sftp, '../../outside/secret.txt'));
    } finally {
      await stop();
    }
  });

  await t.test('will not follow a symlink out of the directory', async () => {
    const { sftp, root, outside, stop } = await serve();
    try {
      await fs.symlink(outside, path.join(root, 'escape'));

      await assert.rejects(readFile(sftp, '/escape/secret.txt'));
      await assert.rejects(writeFile(sftp, '/escape/planted.txt', 'owned'));
      assert.equal(await exists(path.join(outside, 'planted.txt')), false);
    } finally {
      await stop();
    }
  });

  await t.test('refuses to make a symlink at all', async () => {
    // A symlink is the one file a customer could plant that every later path
    // check has to catch. Nothing a game server needs is made this way.
    const { sftp, root, stop } = await serve();
    try {
      await assert.rejects(
        new Promise<void>((resolve, reject) =>
          sftp.symlink('/etc', '/escape', (error) => (error ? reject(error) : resolve())),
        ),
      );
      assert.equal(await exists(path.join(root, 'escape')), false);
    } finally {
      await stop();
    }
  });

  await t.test('will not remove the server root', async () => {
    const { sftp, root, stop } = await serve();
    try {
      await assert.rejects(
        new Promise<void>((resolve, reject) =>
          sftp.rmdir('/', (error) => (error ? reject(error) : resolve())),
        ),
      );
      assert.equal(await exists(root), true);
    } finally {
      await stop();
    }
  });

  /* ------------------------------------------------ over the disk limit -- */

  await t.test('a read-only session may still read, list and delete', async () => {
    // Being over a limit has to be a state somebody can get out of.
    const { sftp, root, stop } = await serve({ writable: false });
    try {
      await fs.writeFile(path.join(root, 'world.dat'), 'big');
      assert.equal(await readFile(sftp, '/world.dat'), 'big');

      await new Promise<void>((resolve, reject) =>
        sftp.unlink('/world.dat', (error) => (error ? reject(error) : resolve())),
      );
      assert.equal(await exists(path.join(root, 'world.dat')), false);
    } finally {
      await stop();
    }
  });

  await t.test('a read-only session cannot open a file for writing', async () => {
    const { sftp, root, stop } = await serve({ writable: false });
    try {
      await assert.rejects(writeFile(sftp, '/upload.jar', 'x'));
      assert.equal(await exists(path.join(root, 'upload.jar')), false);
    } finally {
      await stop();
    }
  });

  await t.test('a read-only session cannot conjure directories by reading', async () => {
    // OPEN made the parent directory before looking at the mode, so asking to
    // *read* a path that does not exist built the path on the way to failing —
    // on a session that was told it may not add anything at all.
    const { sftp, root, stop } = await serve({ writable: false });
    try {
      await assert.rejects(readFile(sftp, '/made/up/path/file.txt'));
      assert.equal(
        await exists(path.join(root, 'made')),
        false,
        'a read created directories on disk',
      );
    } finally {
      await stop();
    }
  });

  await t.test('a read does not create directories even when writing is allowed', async () => {
    const { sftp, root, stop } = await serve();
    try {
      await assert.rejects(readFile(sftp, '/also/made/up.txt'));
      assert.equal(await exists(path.join(root, 'also')), false);
    } finally {
      await stop();
    }
  });

  /* -------------------------------------------------- big directories -- */

  await t.test('lists a directory with more entries than fit in one packet', async () => {
    // A world's region folder is thousands of files. The listing was answered
    // in a single reply, which the protocol cannot carry: past a few thousand
    // entries the client gets nothing at all, and the customer sees an empty
    // folder where their world is.
    const { sftp, root, stop } = await serve();
    try {
      const many = path.join(root, 'region');
      await fs.mkdir(many, { recursive: true });
      await Promise.all(
        Array.from({ length: 5000 }, (_, index) =>
          fs.writeFile(path.join(many, `r.${index}.0.mca`), ''),
        ),
      );

      const listed = await readdir(sftp, '/region');
      assert.equal(listed.length, 5000);
    } finally {
      await stop();
    }
  });

  await t.test('lists a small directory in full, with types', async () => {
    const { sftp, root, stop } = await serve();
    try {
      await fs.mkdir(path.join(root, 'plugins'), { recursive: true });
      await fs.writeFile(path.join(root, 'eula.txt'), 'eula=true\n');

      const listed = await readdir(sftp, '/');
      const names = listed.map((entry) => entry.filename).sort();
      assert.deepEqual(names, ['eula.txt', 'plugins']);
      assert.match(
        listed.find((entry) => entry.filename === 'plugins')?.longname ?? '',
        /^d/,
        'a directory was not shown as one',
      );
    } finally {
      await stop();
    }
  });
});
