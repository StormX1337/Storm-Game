import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import ssh2 from 'ssh2';
import type { FastifyBaseLogger as Logger } from 'fastify';
import type { ServerPaths } from '../lib/paths.js';
import type { PanelClient } from './panel-client.js';

const { Server: SshServer, utils } = ssh2;

export interface SftpServiceOptions {
  port: number;
  hostKeyPath: string;
  paths: ServerPaths;
  panel: PanelClient;
  logger: Logger;
}

/**
 * SFTP access to server files.
 *
 * Every session is chrooted to one server's directory: handles are resolved
 * through `ServerPaths`, so a client that sends `../../etc/passwd` gets a
 * permission error rather than the host's file. Credentials are validated by
 * the panel on each connection, never cached here.
 */
export class SftpService {
  private server: ssh2.Server | null = null;
  private readonly log: Logger;

  constructor(private readonly options: SftpServiceOptions) {
    this.log = options.logger.child({ component: 'sftp' });
  }

  /** Generates a host key on first boot so the fingerprint stays stable. */
  private async hostKey(): Promise<Buffer> {
    const existing = await fsp.readFile(this.options.hostKeyPath).catch(() => null);
    if (existing) return existing;

    this.log.info({ path: this.options.hostKeyPath }, 'generating SFTP host key');
    // ssh2 needs OpenSSH-format keys; node's crypto only emits PKCS8/SPKI.
    const pair = utils.generateKeyPairSync('ed25519');

    await fsp.mkdir(path.dirname(this.options.hostKeyPath), { recursive: true });
    await fsp.writeFile(this.options.hostKeyPath, pair.private, { mode: 0o600 });
    return Buffer.from(pair.private);
  }

  async start(): Promise<void> {
    const hostKey = await this.hostKey();

    this.server = new SshServer(
      {
        hostKeys: [hostKey],
        banner: 'Storm Panel SFTP',
        ident: 'StormPanel',
      },
      (client) => {
        let serverUuid: string | null = null;

        client
          .on('authentication', (ctx) => {
            void (async () => {
              if (ctx.method !== 'password') {
                ctx.reject(['password'], false);
                return;
              }

              const result = await this.options.panel.authenticateSftp(
                ctx.username,
                (ctx as ssh2.PasswordAuthContext).password,
              );

              if (!result) {
                this.log.warn({ username: ctx.username }, 'sftp authentication rejected');
                ctx.reject(['password'], false);
                return;
              }

              serverUuid = result.uuid;
              ctx.accept();
            })();
          })
          .on('ready', () => {
            client.on('session', (acceptSession) => {
              const session = acceptSession();
              session.on('sftp', (acceptSftp) => {
                if (!serverUuid) {
                  client.end();
                  return;
                }
                this.attachSftp(acceptSftp(), serverUuid);
              });
            });
          })
          .on('error', (error) => {
            // Clients disconnecting mid-transfer is routine, not an incident.
            this.log.debug({ err: error }, 'sftp client error');
          });
      },
    );

    await new Promise<void>((resolve) => {
      this.server?.listen(this.options.port, '0.0.0.0', () => {
        this.log.info({ port: this.options.port }, 'SFTP server listening');
        resolve();
      });
    });
  }

  private attachSftp(sftp: ssh2.SFTPWrapper, uuid: string): void {
    const { STATUS_CODE, OPEN_MODE } = utils.sftp;
    const handles = new Map<number, { fd: number; path: string }>();
    const readdirs = new Map<number, { entries: ssh2.FileEntry[]; done: boolean }>();
    let nextHandle = 0;

    const makeHandle = (): Buffer => {
      const id = nextHandle;
      nextHandle += 1;
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32BE(id, 0);
      return buffer;
    };

    /** Resolves a client path, mapping traversal attempts to a clean failure. */
    const resolve = async (requested: string): Promise<string | null> => {
      try {
        return await this.options.paths.resolveChecked(uuid, requested);
      } catch {
        return null;
      }
    };

    sftp.on('REALPATH', (reqid, givenPath) => {
      void (async () => {
        const normalised = path.posix.normalize(givenPath === '.' ? '/' : givenPath);
        const target = await resolve(normalised);
        if (!target) {
          sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          return;
        }
        const display = this.options.paths.relative(uuid, target);
        sftp.name(reqid, [{ filename: display, longname: display, attrs: {} as ssh2.Attributes }]);
      })();
    });

    sftp.on('STAT', (reqid, givenPath) => void this.stat(sftp, reqid, resolve, givenPath, false));
    sftp.on('LSTAT', (reqid, givenPath) => void this.stat(sftp, reqid, resolve, givenPath, true));

    sftp.on('FSTAT', (reqid, handle) => {
      const entry = handles.get(handle.readUInt32BE(0));
      if (!entry) {
        sftp.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      fs.fstat(entry.fd, (error, stats) => {
        if (error) {
          sftp.status(reqid, STATUS_CODE.FAILURE);
          return;
        }
        sftp.attrs(reqid, toAttrs(stats));
      });
    });

    sftp.on('OPEN', (reqid, filename, flags) => {
      void (async () => {
        const target = await resolve(filename);
        if (!target) {
          sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          return;
        }

        let mode = 'r';
        if (flags & OPEN_MODE.WRITE) mode = flags & OPEN_MODE.APPEND ? 'a' : 'w';
        if (flags & OPEN_MODE.READ && flags & OPEN_MODE.WRITE) mode = 'r+';

        await fsp.mkdir(path.dirname(target), { recursive: true }).catch(() => undefined);

        fs.open(target, mode, 0o644, (error, fd) => {
          if (error) {
            sftp.status(reqid, error.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
            return;
          }
          const handle = makeHandle();
          handles.set(handle.readUInt32BE(0), { fd, path: target });
          sftp.handle(reqid, handle);
        });
      })();
    });

    sftp.on('READ', (reqid, handle, offset, length) => {
      const entry = handles.get(handle.readUInt32BE(0));
      if (!entry) {
        sftp.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      const buffer = Buffer.alloc(length);
      fs.read(entry.fd, buffer, 0, length, offset, (error, bytesRead) => {
        if (error) {
          sftp.status(reqid, STATUS_CODE.FAILURE);
          return;
        }
        if (bytesRead === 0) {
          sftp.status(reqid, STATUS_CODE.EOF);
          return;
        }
        sftp.data(reqid, buffer.subarray(0, bytesRead));
      });
    });

    sftp.on('WRITE', (reqid, handle, offset, data) => {
      const entry = handles.get(handle.readUInt32BE(0));
      if (!entry) {
        sftp.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      fs.write(entry.fd, data, 0, data.length, offset, (error) => {
        sftp.status(reqid, error ? STATUS_CODE.FAILURE : STATUS_CODE.OK);
      });
    });

    sftp.on('CLOSE', (reqid, handle) => {
      const id = handle.readUInt32BE(0);
      const entry = handles.get(id);

      if (entry) {
        handles.delete(id);
        fs.close(entry.fd, () => {
          // Uploaded files must belong to the container's uid, or the game
          // server will not be able to read them.
          fs.chown(entry.path, 1000, 1000, () => sftp.status(reqid, STATUS_CODE.OK));
        });
        return;
      }

      if (readdirs.has(id)) {
        readdirs.delete(id);
        sftp.status(reqid, STATUS_CODE.OK);
        return;
      }
      sftp.status(reqid, STATUS_CODE.OK);
    });

    sftp.on('OPENDIR', (reqid, givenPath) => {
      void (async () => {
        const target = await resolve(givenPath);
        if (!target) {
          sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          return;
        }

        const dirents = await fsp.readdir(target, { withFileTypes: true }).catch(() => null);
        if (!dirents) {
          sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          return;
        }

        const entries: ssh2.FileEntry[] = [];
        for (const dirent of dirents) {
          const stats = await fsp.lstat(path.join(target, dirent.name)).catch(() => null);
          if (!stats) continue;
          entries.push({
            filename: dirent.name,
            longname: longname(dirent.name, stats),
            attrs: toAttrs(stats),
          });
        }

        const handle = makeHandle();
        readdirs.set(handle.readUInt32BE(0), { entries, done: false });
        sftp.handle(reqid, handle);
      })();
    });

    sftp.on('READDIR', (reqid, handle) => {
      const id = handle.readUInt32BE(0);
      const state = readdirs.get(id);
      if (!state) {
        sftp.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      if (state.done) {
        sftp.status(reqid, STATUS_CODE.EOF);
        return;
      }
      state.done = true;
      sftp.name(reqid, state.entries);
    });

    sftp.on('REMOVE', (reqid, givenPath) => {
      void (async () => {
        const target = await resolve(givenPath);
        if (!target) {
          sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          return;
        }
        const error = await fsp.unlink(target).catch((e: NodeJS.ErrnoException) => e);
        sftp.status(reqid, error ? STATUS_CODE.FAILURE : STATUS_CODE.OK);
      })();
    });

    sftp.on('RMDIR', (reqid, givenPath) => {
      void (async () => {
        const target = await resolve(givenPath);
        if (!target || target === this.options.paths.root(uuid)) {
          sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          return;
        }
        const error = await fsp.rmdir(target).catch((e: NodeJS.ErrnoException) => e);
        sftp.status(reqid, error ? STATUS_CODE.FAILURE : STATUS_CODE.OK);
      })();
    });

    sftp.on('MKDIR', (reqid, givenPath) => {
      void (async () => {
        const target = await resolve(givenPath);
        if (!target) {
          sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          return;
        }
        const error = await fsp
          .mkdir(target, { recursive: true })
          .then(() => fsp.chown(target, 1000, 1000))
          .catch((e: NodeJS.ErrnoException) => e);
        sftp.status(reqid, error instanceof Error ? STATUS_CODE.FAILURE : STATUS_CODE.OK);
      })();
    });

    sftp.on('RENAME', (reqid, oldPath, newPath) => {
      void (async () => {
        const [from, to] = await Promise.all([resolve(oldPath), resolve(newPath)]);
        if (!from || !to) {
          sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          return;
        }
        const error = await fsp.rename(from, to).catch((e: NodeJS.ErrnoException) => e);
        sftp.status(reqid, error ? STATUS_CODE.FAILURE : STATUS_CODE.OK);
      })();
    });

    sftp.on('SETSTAT', (reqid) => {
      // Permission and timestamp changes are accepted but ignored: the panel
      // owns file ownership, and honouring chmod here would let a client mark
      // files unreadable by the container user.
      sftp.status(reqid, STATUS_CODE.OK);
    });

    sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));

    sftp.on('close', () => {
      for (const entry of handles.values()) {
        fs.close(entry.fd, () => undefined);
      }
      handles.clear();
      readdirs.clear();
    });
  }

  private async stat(
    sftp: ssh2.SFTPWrapper,
    reqid: number,
    resolve: (requested: string) => Promise<string | null>,
    givenPath: string,
    useLstat: boolean,
  ): Promise<void> {
    const { STATUS_CODE } = utils.sftp;
    const target = await resolve(givenPath);
    if (!target) {
      sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
      return;
    }

    const stats = await (useLstat ? fsp.lstat(target) : fsp.stat(target)).catch(() => null);
    if (!stats) {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      return;
    }
    sftp.attrs(reqid, toAttrs(stats));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }
}

function toAttrs(stats: fs.Stats): ssh2.Attributes {
  return {
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

/** `ls -l` style line some SFTP clients display verbatim. */
function longname(name: string, stats: fs.Stats): string {
  const type = stats.isDirectory() ? 'd' : stats.isSymbolicLink() ? 'l' : '-';
  const permissions = (stats.mode & 0o777).toString(8).padStart(3, '0');
  const date = stats.mtime.toISOString().slice(0, 16).replace('T', ' ');
  return `${type}${permissions} 1 container container ${String(stats.size).padStart(12)} ${date} ${name}`;
}
