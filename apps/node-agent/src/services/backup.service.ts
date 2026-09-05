import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { create as createTar, extract as extractTar, list as listTar } from 'tar';
import { request } from 'undici';
import type { FastifyBaseLogger as Logger } from 'fastify';
import type { Readable } from 'node:stream';
import type {
  AgentBackupRequest,
  AgentBackupResult,
  AgentDownloadSource,
  AgentRestoreRequest,
  AgentUploadTarget,
} from '@storm/types';
import { resolveSafePath } from '@storm/security';
import type { ServerPaths } from '../lib/paths.js';
import { AgentError, notFound } from '../lib/errors.js';

export interface BackupServiceOptions {
  backupDirectory: string;
  paths: ServerPaths;
  logger: Logger;
}

/** Never worth archiving: caches, sockets and the agent's own scratch space. */
const ALWAYS_IGNORED = ['.storm', 'cache/**', 'logs/latest.log.lck', '**/*.sock'];

/**
 * Creates and restores server backups as gzipped tar archives.
 *
 * The archive is always written to local disk first so the checksum can be
 * computed and the transfer retried; for object-storage drivers it is then
 * streamed to a pre-signed URL and the local copy removed, so archive bytes
 * never pass through the panel.
 */
export class BackupService {
  private readonly log: Logger;

  constructor(private readonly options: BackupServiceOptions) {
    this.log = options.logger.child({ component: 'backup' });
  }

  private archivePath(serverUuid: string, backupUuid: string): string {
    return path.join(this.options.backupDirectory, serverUuid, `${backupUuid}.tar.gz`);
  }

  async create(input: AgentBackupRequest): Promise<AgentBackupResult> {
    const root = this.options.paths.root(input.uuid);
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory()) throw notFound('That server has no data directory on this node');

    const target = this.archivePath(input.uuid, input.backupUuid);
    await fs.mkdir(path.dirname(target), { recursive: true });

    const ignore = [...ALWAYS_IGNORED, ...input.ignore];
    this.log.info({ uuid: input.uuid, backup: input.backupUuid }, 'creating backup archive');

    const entries = await fs.readdir(root);
    const included = entries.filter((entry) => !ignore.includes(entry));

    await createTar(
      {
        gzip: true,
        file: target,
        cwd: root,
        portable: true,
        // A missing file mid-archive (a game rotating a log) must not fail the
        // whole backup.
        noDirRecurse: false,
        filter: (entryPath: string) => !matchesIgnore(entryPath, ignore),
      },
      included.length > 0 ? included : ['.'],
    );

    const [checksum, size] = await Promise.all([
      checksumFile(target),
      fs.stat(target).then((info) => info.size),
    ]);

    if (input.upload && input.upload.driver !== 'LOCAL') {
      await this.upload(target, input.upload, size);
      // The panel is now the system of record for this archive.
      await fs.rm(target, { force: true });
      this.log.info(
        { backup: input.backupUuid, bytes: size },
        'archive uploaded to object storage',
      );
    }

    return {
      backupUuid: input.backupUuid,
      bytes: size,
      checksum,
      checksumType: 'sha256',
      completedAt: new Date().toISOString(),
    };
  }

  async restore(input: AgentRestoreRequest): Promise<void> {
    const root = await this.options.paths.ensureRoot(input.uuid);
    let archive = this.archivePath(input.uuid, input.backupUuid);
    let temporary = false;

    if (input.download && input.download.driver !== 'LOCAL') {
      archive = path.join(this.options.backupDirectory, `.restore-${input.backupUuid}.tar.gz`);
      await fs.mkdir(path.dirname(archive), { recursive: true });
      await this.download(input.download, archive);
      temporary = true;
    }

    const stat = await fs.stat(archive).catch(() => null);
    if (!stat) throw notFound('That backup archive is not available on this node');

    try {
      // Read the archive through before touching the live directory.
      //
      // The order used to be: empty the directory, then extract. So a
      // truncated download, a half-written file, or simply the wrong bytes
      // took the live world with it and left nothing to put back — during the
      // one operation somebody reaches for when something has already gone
      // wrong. Listing the archive costs a second read of it and answers the
      // question that matters: is this whole and readable?
      //
      // It does not cover a failure during the extraction itself — a disk that
      // fills halfway can still leave a partial tree — but it does cover every
      // way the archive can be no good, which is how this fails in practice.
      //
      // A checksum, when the panel has one, answers a stronger question than
      // "does this parse": it says these are the exact bytes that were written
      // when the backup was taken. The panel has computed and stored that
      // sha256 since the first release and never once read it back — the one
      // integrity check in the system was write-only. Archives predating this
      // have none on record, so the listing stays as the fallback.
      if (input.checksum) {
        await assertChecksum(archive, input.checksum);
      } else {
        await assertReadable(archive);
      }

      if (input.truncate) {
        // Wipe the directory contents but keep the directory itself: it is a
        // live bind mount for the container.
        const entries = await fs.readdir(root);
        for (const entry of entries) {
          await fs.rm(path.join(root, entry), { recursive: true, force: true });
        }
      }

      this.log.info({ uuid: input.uuid, backup: input.backupUuid }, 'restoring backup archive');
      await extractTar({ file: archive, cwd: root, preservePaths: false, strip: 0 });
      await chownRecursive(root, 1000, 1000);
    } finally {
      if (temporary) await fs.rm(archive, { force: true }).catch(() => undefined);
    }
  }

  async remove(serverUuid: string, backupUuid: string): Promise<void> {
    const target = this.archivePath(serverUuid, backupUuid);
    await fs.rm(target, { force: true });
  }

  /**
   * Removes every archive a server has on this node.
   *
   * Backups do not live under the server directory — they live beside it, in
   * `backupDirectory/<uuid>/` — so wiping the server root leaves them behind.
   * That is by design while the server exists (an archive that a `truncate`
   * restore could delete would be worthless), but once the server is gone
   * they are full-size files that nothing on either side can reach: the panel
   * cascades the rows away in the same breath, so no download, no retention
   * sweep and no future delete will ever name them again.
   *
   * The panel removes each archive it still has a row for before it gets
   * here. This takes the directory, which also catches archives whose rows
   * were already lost — every server deleted before this existed left its
   * entire backup history on the node's disk.
   */
  async removeAll(serverUuid: string): Promise<void> {
    const directory = resolveSafePath(this.options.backupDirectory, serverUuid);
    // A uuid can never be the backup root itself, but deleting the directory
    // that holds every server's archives is not a mistake worth being one
    // validator away from.
    if (directory === path.resolve(this.options.backupDirectory)) return;
    await fs.rm(directory, { recursive: true, force: true });
  }

  async open(serverUuid: string, backupUuid: string): Promise<{ stream: Readable; size: number }> {
    const target = this.archivePath(serverUuid, backupUuid);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) throw notFound('That backup archive is not on this node', 'BACKUP_NOT_FOUND');
    return { stream: createReadStream(target), size: stat.size };
  }

  /** PUTs the archive to a pre-signed URL supplied by the panel. */
  private async upload(archive: string, target: AgentUploadTarget, size: number): Promise<void> {
    if (!target.url) {
      throw new AgentError(400, 'STORAGE_ERROR', 'No upload URL was supplied for this backup');
    }

    const response = await request(target.url, {
      method: 'PUT',
      body: createReadStream(archive),
      headers: {
        ...target.headers,
        'content-length': String(size),
      },
      headersTimeout: 0,
      bodyTimeout: 0,
    });

    const body = await response.body.text().catch(() => '');
    if (response.statusCode >= 300) {
      throw new AgentError(
        502,
        'STORAGE_ERROR',
        `Backup upload failed with status ${response.statusCode}: ${body.slice(0, 200)}`,
      );
    }
  }

  private async download(source: AgentDownloadSource, destination: string): Promise<void> {
    if (!source.url) {
      throw new AgentError(400, 'STORAGE_ERROR', 'No download URL was supplied for this restore');
    }

    const response = await request(source.url, {
      method: 'GET',
      headers: source.headers,
      headersTimeout: 0,
      bodyTimeout: 0,
    });

    if (response.statusCode >= 300) {
      await response.body.dump();
      throw new AgentError(
        502,
        'STORAGE_ERROR',
        `Backup download failed with status ${response.statusCode}`,
      );
    }

    await pipeline(response.body, createWriteStream(destination));
  }

  /** Total bytes stored locally for a server's backups. */
  async usage(serverUuid: string): Promise<number> {
    const directory = resolveSafePath(this.options.backupDirectory, serverUuid);
    const entries = await fs.readdir(directory).catch(() => []);

    let total = 0;
    for (const entry of entries) {
      const info = await fs.stat(path.join(directory, entry)).catch(() => null);
      total += info?.size ?? 0;
    }
    return total;
  }
}

function matchesIgnore(entryPath: string, patterns: string[]): boolean {
  const normalised = entryPath.replace(/^\.\//, '');
  return patterns.some((pattern) => {
    if (!pattern) return false;
    if (pattern.includes('*')) {
      // Translate the small glob subset customers actually use into a regex.
      const expression = pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      return new RegExp(`^${expression}$`).test(normalised);
    }
    return normalised === pattern || normalised.startsWith(`${pattern}/`);
  });
}

/**
 * Proves an archive is whole and readable, or refuses it.
 *
 * Anything gzip or tar objects to — the wrong bytes entirely, a download that
 * stopped early, a file still being written — surfaces here rather than after
 * the live directory has already been emptied.
 */
async function assertReadable(archive: string): Promise<void> {
  let entries = 0;
  try {
    await listTar({
      file: archive,
      onentry: () => {
        entries += 1;
      },
    });
  } catch (error) {
    throw new AgentError(
      422,
      'BACKUP_CORRUPT',
      `That backup archive could not be read and was not restored: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Every archive this agent writes holds at least the directory itself, so
  // nothing legitimate is empty. Something that is has not finished arriving.
  if (entries === 0) {
    throw new AgentError(
      422,
      'BACKUP_CORRUPT',
      'That backup archive is empty and was not restored',
    );
  }
}

/**
 * Proves an archive is the one the panel says it is.
 *
 * Stronger than reading it through: a whole, well-formed archive can still be
 * the wrong archive, or the right one with a block rotted out of the middle of
 * it in object storage. This is the check the stored sha256 was always for.
 */
async function assertChecksum(archive: string, expected: string): Promise<void> {
  const actual = await checksumFile(archive);
  if (actual !== expected.toLowerCase()) {
    throw new AgentError(
      422,
      'BACKUP_CORRUPT',
      'That backup archive does not match the checksum recorded when it was taken, ' +
        'and was not restored',
    );
  }
}

async function checksumFile(target: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(target), hash);
  return hash.digest('hex');
}

async function chownRecursive(target: string, uid: number, gid: number): Promise<void> {
  await fs.chown(target, uid, gid).catch(() => undefined);
  const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await chownRecursive(child, uid, gid);
    } else {
      await fs.lchown(child, uid, gid).catch(() => undefined);
    }
  }
}
