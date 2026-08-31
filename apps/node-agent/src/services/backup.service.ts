import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { create as createTar, extract as extractTar } from 'tar';
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
