import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import ssh2 from 'ssh2';
import type { FastifyBaseLogger as Logger } from 'fastify';
import type { ServerPaths } from '../lib/paths.js';
import type { PanelClient } from './panel-client.js';

const { Server: SshServer, utils } = ssh2;

/**
 * The file mode an OPEN asks for, or null when this session may not have it.
 *
 * A session is told at login whether it may add bytes: the panel answers no
 * once the server is over the disk it was sold. Refusing here rather than at
 * the first WRITE means the client reports it against the file it was opening,
 * instead of failing halfway through a transfer with nothing to point at.
 *
 * Reading is always allowed. So are deleting and renaming, elsewhere — being
 * over a limit has to be a state somebody can get themselves out of.
 */
export function openModeFor(flags: number, writable: boolean): string | null {
  const { OPEN_MODE } = utils.sftp;

  let mode = 'r';
  if (flags & OPEN_MODE.WRITE) mode = flags & OPEN_MODE.APPEND ? 'a' : 'w';
  if (flags & OPEN_MODE.READ && flags & OPEN_MODE.WRITE) mode = 'r+';

  if (mode !== 'r' && !writable) return null;
  return mode;
}

/**
 * How many directory entries go in one READDIR reply.
 *
 * The listing used to be answered in a single reply with everything in it,
 * which the protocol cannot carry: past a few thousand entries the packet is
 * too big to send and the client waits for an answer that never comes — the
 * customer sees an empty folder where their world is. A batch of sixty-four
 * `ls -l` lines is comfortably inside a channel packet, and the client asks
 * again until it gets EOF, which is how READDIR was always meant to work.
 */
const READDIR_BATCH = 64;

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

  /** The port actually bound, which differs from the configured one on 0. */
  get boundPort(): number {
    const address = this.server?.address();
    return typeof address === 'object' && address ? address.port : this.options.port;
  }

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
        let writable = false;

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
              // The panel decides this per login, from the server's disk
              // usage. A session that may not write can still list, read,
              // delete and rename — being over a limit has to be a state the
              // customer can get out of.
              writable = result.writable;
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
                this.attachSftp(acceptSftp(), serverUuid, writable);
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

  private attachSftp(sftp: ssh2.SFTPWrapper, uuid: string, writable: boolean): void {
    const { STATUS_CODE } = utils.sftp;
    const handles = new Map<number, { fd: number; path: string }>();
    const readdirs = new Map<number, { dir: string; names: string[]; offset: number }>();
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

        const mode = openModeFor(flags, writable);
        if (mode === null) {
          sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          return;
        }

        // Only a write makes the path it is about to write into. This ran for
        // every open, so asking to *read* a file that does not exist built the
        // directories on the way to failing — including on a session the panel
        // had told may not add anything at all.
        if (mode !== 'r') {
          await fsp.mkdir(path.dirname(target), { recursive: true }).catch(() => undefined);
        }

        fs.open(target, mode, 0o644, (error, fd) => {
          if (error) {
            sftp.status(
              reqid,
              error.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE,
            );
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

        const names = await fsp.readdir(target).catch(() => null);
        if (!names) {
          sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          return;
        }

        // Only the names here: a world's region folder is thousands of files,
        // and stat-ing all of them before answering makes opening the
        // directory take as long as reading it. Each batch stats its own.
        const handle = makeHandle();
        readdirs.set(handle.readUInt32BE(0), { dir: target, names, offset: 0 });
        sftp.handle(reqid, handle);
      })();
    });

    sftp.on('READDIR', (reqid, handle) => {
      void (async () => {
        const id = handle.readUInt32BE(0);
        const state = readdirs.get(id);
        if (!state) {
          sftp.status(reqid, STATUS_CODE.FAILURE);
          return;
        }
        if (state.offset >= state.names.length) {
          sftp.status(reqid, STATUS_CODE.EOF);
          return;
        }

        const batch = state.names.slice(state.offset, state.offset + READDIR_BATCH);
        state.offset += batch.length;

        const entries: ssh2.FileEntry[] = [];
        for (const name of batch) {
          const stats = await fsp.lstat(path.join(state.dir, name)).catch(() => null);
          if (!stats) continue;
          entries.push({ filename: name, longname: longname(name, stats), attrs: toAttrs(stats) });
        }

        // A batch whose entries all vanished between the readdir and here is
        // not the end of the listing; answering EOF would truncate it.
        if (entries.length === 0) {
          sftp.name(reqid, []);
          return;
        }
        sftp.name(reqid, entries);
      })();
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

    // MKDIR, REMOVE, RMDIR and RENAME stay open even read-only, matching the
    // file manager: an empty directory is not what filled the disk, and
    // deleting is how somebody gets back under their limit.
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

    // Links are refused outright rather than left unhandled.
    //
    // A symlink is the one file a customer could create that points somewhere
    // the path checks would otherwise have to catch on every later read, and
    // there is no reason a game server needs one made over SFTP.
    //
    // ssh2 would refuse these anyway: a request type with no listener is
    // answered OP_UNSUPPORTED automatically. Saying it here is a statement of
    // intent rather than a fix — the refusal is deliberate, so it should not
    // depend on a library default that could reasonably change, and a reader
    // should not have to know that default to know links are not allowed. (An
    // earlier version of this comment claimed the opposite, that an unhandled
    // request hangs the client. It does not.)
    sftp.on('SYMLINK', (reqid) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED));
    sftp.on('READLINK', (reqid) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED));

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
