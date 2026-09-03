import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BackupStorage, Node as NodeRow } from '@storm/database';
import { ErrorCode, type AgentDownloadSource, type AgentUploadTarget } from '@storm/types';
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
 * bytes travel node -> bucket directly and never transit the panel.
 *
 * For the LOCAL driver the archive never leaves the node it was made on. The
 * panel holds no copy — a download is proxied from the agent, and a deletion
 * has to be asked of the agent too. That last part is why `removeArchive`
 * takes the node: `remove` used to be the whole story and every caller had to
 * remember the branch itself. Two of the three did. The third left a
 * full-size archive on a node after every server move, with the row that knew
 * about it deleted in the same breath.
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

  /**
   * Deletes one archive, wherever it actually lives.
   *
   * A LOCAL archive is on the node that made it, so the only way to remove it
   * is to ask that node. Every caller used to carry that branch, which is one
   * place too many: the move worker did not, and quietly left the archive
   * behind on the source node after deleting the record that knew where it
   * was. Nothing would ever have found it again.
   */
  async removeArchive(
    storage: BackupStorage,
    archive: { node: NodeRow; serverUuid: string; backupUuid: string; key: string },
  ): Promise<void> {
    if (this.isLocal(storage)) {
      await this.app.agents.request(
        archive.node,
        `/api/v1/servers/${archive.serverUuid}/backups/${archive.backupUuid}`,
        { method: 'DELETE' },
      );
      return;
    }
    const client = this.clientFor(storage);
    await client.send(new DeleteObjectCommand({ Bucket: storage.bucket!, Key: archive.key }));
  }
}

export default fp(
  async function storagePlugin(app: FastifyInstance) {
    app.decorate('storage', new StorageService(app));
  },
  { name: 'storm-storage', dependencies: ['storm-env'] },
);
