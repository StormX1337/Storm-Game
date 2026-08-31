import fp from 'fastify-plugin';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import {
  S3Client,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BackupStorage } from '@storm/database';
import { ErrorCode, type AgentDownloadSource, type AgentUploadTarget } from '@storm/types';
import { resolveSafePath } from '@storm/security';
import { AppError } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    storage: StorageService;
  }
}

/**
 * Backup storage abstraction.
 *
 * For object storage the panel hands the agent a pre-signed URL so archive
 * bytes travel node -> bucket directly and never transit the panel. For the
 * LOCAL driver the agent keeps the archive on its own disk and the panel
 * streams it back on demand.
 */
export class StorageService {
  constructor(private readonly app: FastifyInstance) {}

  private clientFor(storage: BackupStorage): S3Client {
    const accessKey = this.app.encrypter.tryDecrypt(storage.accessKeyEnc);
    const secretKey = this.app.encrypter.tryDecrypt(storage.secretKeyEnc);
    if (!accessKey || !secretKey || !storage.bucket) {
      throw new AppError(
        500,
        ErrorCode.STORAGE_ERROR,
        `Backup storage "${storage.name}" is missing credentials`,
      );
    }
    return new S3Client({
      region: storage.region ?? 'auto',
      endpoint: storage.endpoint ?? undefined,
      forcePathStyle: storage.forcePathStyle,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });
  }

  objectKey(storage: BackupStorage, serverUuid: string, backupUuid: string): string {
    const prefix = storage.pathPrefix.replace(/^\/+|\/+$/g, '');
    return `${prefix}/${serverUuid}/${backupUuid}.tar.gz`;
  }

  isLocal(storage: BackupStorage): boolean {
    return storage.driver === 'LOCAL';
  }

  /** Target the agent uploads a finished archive to. */
  async uploadTarget(
    storage: BackupStorage,
    serverUuid: string,
    backupUuid: string,
  ): Promise<AgentUploadTarget> {
    const key = this.objectKey(storage, serverUuid, backupUuid);
    if (this.isLocal(storage)) {
      return { driver: 'LOCAL', key };
    }
    const client = this.clientFor(storage);
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: storage.bucket!, Key: key }),
      { expiresIn: 6 * 3600 },
    );
    return { driver: storage.driver, url, key, headers: { 'content-type': 'application/gzip' } };
  }

  /** Source the agent downloads an archive from during a restore. */
  async downloadSource(
    storage: BackupStorage,
    serverUuid: string,
    backupUuid: string,
  ): Promise<AgentDownloadSource> {
    const key = this.objectKey(storage, serverUuid, backupUuid);
    if (this.isLocal(storage)) {
      return { driver: 'LOCAL', key };
    }
    const client = this.clientFor(storage);
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: storage.bucket!, Key: key }),
      { expiresIn: 6 * 3600 },
    );
    return { driver: storage.driver, url, key };
  }

  /** Time-limited URL a browser can download a backup from. */
  async presignDownload(
    storage: BackupStorage,
    key: string,
    filename: string,
  ): Promise<string | null> {
    if (this.isLocal(storage)) return null;
    const client = this.clientFor(storage);
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: storage.bucket!,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${filename}"`,
      }),
      { expiresIn: 900 },
    );
  }

  async remove(storage: BackupStorage, key: string): Promise<void> {
    if (this.isLocal(storage)) {
      const root = this.app.env.BACKUP_LOCAL_PATH;
      const target = resolveSafePath(root, key);
      await fs.rm(target, { force: true });
      return;
    }
    const client = this.clientFor(storage);
    await client.send(new DeleteObjectCommand({ Bucket: storage.bucket!, Key: key }));
  }

  async size(storage: BackupStorage, key: string): Promise<number> {
    if (this.isLocal(storage)) {
      const target = resolveSafePath(this.app.env.BACKUP_LOCAL_PATH, key);
      const stat = await fs.stat(target).catch(() => null);
      return stat?.size ?? 0;
    }
    const client = this.clientFor(storage);
    const head = await client.send(new HeadObjectCommand({ Bucket: storage.bucket!, Key: key }));
    return head.ContentLength ?? 0;
  }

  /** Opens a local archive for streaming back to the browser. */
  async openLocal(key: string): Promise<Readable> {
    const target = resolveSafePath(this.app.env.BACKUP_LOCAL_PATH, key);
    await fs.access(target).catch(() => {
      throw new AppError(
        404,
        ErrorCode.BACKUP_NOT_FOUND,
        'That backup archive is no longer on disk',
      );
    });
    return createReadStream(target);
  }

  async ensureLocalDirectory(key: string): Promise<string> {
    const target = resolveSafePath(this.app.env.BACKUP_LOCAL_PATH, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    return target;
  }
}

export default fp(
  async function storagePlugin(app: FastifyInstance) {
    app.decorate('storage', new StorageService(app));
  },
  { name: 'storm-storage', dependencies: ['storm-env'] },
);
