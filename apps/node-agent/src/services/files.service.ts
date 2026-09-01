import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { request } from 'undici';
import archiver from 'archiver';
import unzipper from 'unzipper';
import type { Readable } from 'node:stream';
import type { AgentFileEntry } from '@storm/types';
import { sanitizeFilename } from '@storm/security';
import type { ServerPaths } from '../lib/paths.js';
import { AgentError, badRequest, notFound } from '../lib/errors.js';

const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.xml': 'application/xml',
  '.properties': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.ini': 'text/plain',
  '.toml': 'text/plain',
  '.sh': 'application/x-sh',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.lua': 'text/x-lua',
  '.py': 'text/x-python',
  '.jar': 'application/java-archive',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mca': 'application/octet-stream',
  '.dat': 'application/octet-stream',
};

/** Text files editable in the browser are capped so the panel stays responsive. */
const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 500;
const MAX_SEARCH_DEPTH = 12;

/**
 * Filesystem operations inside a server directory.
 *
 * Every public method resolves its input through `ServerPaths`, which enforces
 * the traversal and symlink rules, so nothing here manipulates a caller-supplied
 * path directly.
 */
export class FilesService {
  constructor(private readonly paths: ServerPaths) {}

  async list(uuid: string, requested: string): Promise<AgentFileEntry[]> {
    const target = await this.paths.resolveChecked(uuid, requested);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) throw notFound('That directory does not exist');
    if (!stat.isDirectory()) throw badRequest('That path is not a directory');

    const entries = await fs.readdir(target, { withFileTypes: true });

    const results = await Promise.all(
      entries.map(async (entry) => {
        const absolute = path.join(target, entry.name);
        // lstat, not stat: a broken symlink must still be listable.
        const info = await fs.lstat(absolute).catch(() => null);
        if (!info) return null;

        const isSymlink = info.isSymbolicLink();
        const resolved = isSymlink ? await fs.stat(absolute).catch(() => null) : info;

        return {
          name: entry.name,
          path: this.paths.relative(uuid, absolute),
          size: resolved?.size ?? 0,
          isDirectory: resolved?.isDirectory() ?? false,
          isFile: resolved?.isFile() ?? false,
          isSymlink,
          mimeType: resolved?.isDirectory()
            ? 'inode/directory'
            : (MIME_TYPES[path.extname(entry.name).toLowerCase()] ?? 'application/octet-stream'),
          mode: (info.mode & 0o777).toString(8).padStart(3, '0'),
          modifiedAt: info.mtime.toISOString(),
          createdAt: info.birthtime.toISOString(),
        } satisfies AgentFileEntry;
      }),
    );

    return results
      .filter((entry): entry is AgentFileEntry => entry !== null)
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
  }

  async read(uuid: string, requested: string): Promise<string> {
    const target = await this.paths.resolveChecked(uuid, requested);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) throw notFound('That file does not exist');
    if (stat.isDirectory()) throw badRequest('That path is a directory');
    if (stat.size > MAX_EDITABLE_BYTES) {
      throw new AgentError(413, 'FILE_TOO_LARGE', 'That file is too large to open in the editor');
    }
    return fs.readFile(target, 'utf8');
  }

  async openStream(
    uuid: string,
    requested: string,
  ): Promise<{ stream: Readable; size: number; name: string }> {
    const target = await this.paths.resolveChecked(uuid, requested);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) throw notFound('That file does not exist');
    if (stat.isDirectory()) throw badRequest('Directories cannot be downloaded directly');

    return { stream: createReadStream(target), size: stat.size, name: path.basename(target) };
  }

  async write(uuid: string, requested: string, content: string): Promise<void> {
    const target = await this.paths.resolveChecked(uuid, requested);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    await this.own(target);
  }

  /** Streams an upload straight to disk so large files never sit in memory. */
  async writeStream(uuid: string, requested: string, source: Readable): Promise<number> {
    const target = await this.paths.resolveChecked(uuid, requested);
    await fs.mkdir(path.dirname(target), { recursive: true });

    await pipeline(source, createWriteStream(target));
    const stat = await fs.stat(target);
    await this.own(target);
    return stat.size;
  }

  /**
   * Downloads a file into the server directory, and refuses anything that is
   * not exactly what was asked for.
   *
   * This is how a plugin gets installed, so three things are not optional. The
   * download is capped, because a server's disk is not the panel's to fill.
   * The digest is checked, because "whatever that URL returned" is not an
   * install — a mirror serving something else, or a truncated transfer, has to
   * fail here rather than at the server's next start. And it lands on a
   * temporary name first: a half-written jar that the game then tries to load
   * is worse than no jar at all.
   *
   * The URL is not the caller's to choose. The panel resolves it from the
   * registry and checks where it points; nothing here treats an arbitrary
   * address as safe just because it arrived over an authenticated channel.
   */
  async fetchInto(
    uuid: string,
    requested: string,
    source: { url: string; sha512?: string; maxBytes: number },
  ): Promise<{ path: string; bytes: number; sha512: string }> {
    const target = await this.paths.resolveChecked(uuid, requested);
    const partial = `${target}.part`;
    await fs.mkdir(path.dirname(target), { recursive: true });

    const response = await request(source.url, {
      method: 'GET',
      maxRedirections: 3,
      headers: { 'user-agent': 'StormPanel/1.0' },
      headersTimeout: 30_000,
      bodyTimeout: 10 * 60_000,
    });

    if (response.statusCode >= 400) {
      response.body.destroy();
      throw new AgentError(502, 'DOWNLOAD_FAILED', `The download answered ${response.statusCode}`);
    }

    const digest = createHash('sha512');
    let bytes = 0;

    try {
      await pipeline(
        response.body,
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            bytes += chunk.length;
            if (bytes > source.maxBytes) {
              // Thrown mid-stream so the transfer stops here rather than
              // after the whole file has already been written.
              throw new AgentError(
                413,
                'FILE_TOO_LARGE',
                `The download is larger than ${source.maxBytes} bytes`,
              );
            }
            digest.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(partial),
      );

      const sha512 = digest.digest('hex');
      if (source.sha512 && sha512 !== source.sha512.toLowerCase()) {
        throw new AgentError(
          502,
          'CHECKSUM_MISMATCH',
          'The download did not match the checksum the registry published',
        );
      }

      await fs.rename(partial, target);
      await this.own(target);
      return { path: requested, bytes, sha512 };
    } catch (error) {
      await fs.rm(partial, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async createDirectory(uuid: string, requested: string, name: string): Promise<void> {
    const clean = sanitizeFilename(name);
    const parent = await this.paths.resolveChecked(uuid, requested);
    const target = await this.paths.resolveChecked(uuid, path.join(requested, clean));

    await fs.mkdir(parent, { recursive: true });
    await fs.mkdir(target, { recursive: true });
    await this.own(target);
  }

  async rename(uuid: string, from: string, to: string): Promise<void> {
    const source = await this.paths.resolveChecked(uuid, from);
    const destination = await this.paths.resolveChecked(uuid, to);

    if (!(await this.exists(source))) throw notFound('That file does not exist');
    if (await this.exists(destination))
      throw badRequest('Something already exists at the destination');

    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
  }

  /** Copies a file or directory; without a destination it appends " copy". */
  async copy(uuid: string, requested: string, destination?: string): Promise<string> {
    const source = await this.paths.resolveChecked(uuid, requested);
    if (!(await this.exists(source))) throw notFound('That file does not exist');

    let target: string;
    if (destination) {
      target = await this.paths.resolveChecked(uuid, destination);
    } else {
      const extension = path.extname(source);
      const base = path.basename(source, extension);
      const directory = path.dirname(source);

      let candidate = path.join(directory, `${base} copy${extension}`);
      let counter = 2;
      while (await this.exists(candidate)) {
        candidate = path.join(directory, `${base} copy ${counter}${extension}`);
        counter += 1;
        if (counter > 100) throw badRequest('Too many copies of that file already exist');
      }
      target = candidate;
    }

    await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false });
    await this.own(target);
    return this.paths.relative(uuid, target);
  }

  async remove(uuid: string, requestedPaths: string[]): Promise<number> {
    let removed = 0;
    for (const requested of requestedPaths) {
      const target = await this.paths.resolveChecked(uuid, requested);
      // Deleting the server root itself would break the bind mount.
      if (target === this.paths.root(uuid)) {
        throw badRequest('The server root cannot be deleted');
      }
      await fs.rm(target, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  async chmod(uuid: string, requested: string, mode: string): Promise<void> {
    const target = await this.paths.resolveChecked(uuid, requested);
    if (!(await this.exists(target))) throw notFound('That file does not exist');
    await fs.chmod(target, parseInt(mode, 8));
  }

  /* ------------------------------------------------------------ archives -- */

  async compress(
    uuid: string,
    requested: string,
    files: string[],
    archiveName?: string,
  ): Promise<string> {
    // Validated for its own sake: the directory being compressed has to be
    // inside the server root even though only `target` is written to.
    await this.paths.resolveChecked(uuid, requested);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = sanitizeFilename(archiveName ?? `archive-${stamp}.zip`);
    const finalName = name.endsWith('.zip') ? name : `${name}.zip`;
    const target = await this.paths.resolveChecked(uuid, path.join(requested, finalName));

    const output = createWriteStream(target);
    const archive = archiver('zip', { zlib: { level: 6 } });

    const done = new Promise<void>((resolve, reject) => {
      output.on('close', () => resolve());
      archive.on('error', reject);
      output.on('error', reject);
    });

    archive.pipe(output);

    for (const file of files) {
      const clean = sanitizeFilename(file);
      const source = await this.paths.resolveChecked(uuid, path.join(requested, clean));
      const stat = await fs.stat(source).catch(() => null);
      if (!stat) continue;

      if (stat.isDirectory()) {
        archive.directory(source, clean);
      } else {
        archive.file(source, { name: clean });
      }
    }

    await archive.finalize();
    await done;
    await this.own(target);

    return this.paths.relative(uuid, target);
  }

  /**
   * Extracts a zip archive. Each entry's path is re-validated before it is
   * written, so a crafted archive cannot escape the server directory
   * ("zip slip").
   */
  async decompress(uuid: string, requested: string, file: string): Promise<number> {
    const clean = sanitizeFilename(file);
    const archivePath = await this.paths.resolveChecked(uuid, path.join(requested, clean));
    const stat = await fs.stat(archivePath).catch(() => null);
    if (!stat?.isFile()) throw notFound('That archive does not exist');

    const destination = await this.paths.resolveChecked(uuid, requested);
    let extracted = 0;

    const directory = await unzipper.Open.file(archivePath);
    for (const entry of directory.files) {
      if (entry.type === 'Directory') continue;

      const entryTarget = this.paths.resolve(uuid, path.join(requested, entry.path));
      if (!entryTarget.startsWith(destination + path.sep) && entryTarget !== destination) {
        throw new AgentError(
          400,
          'PATH_NOT_ALLOWED',
          `The archive contains an entry that would escape the server directory: ${entry.path}`,
        );
      }

      await fs.mkdir(path.dirname(entryTarget), { recursive: true });
      await pipeline(entry.stream(), createWriteStream(entryTarget));
      await this.own(entryTarget);
      extracted += 1;
    }

    return extracted;
  }

  /* -------------------------------------------------------------- search -- */

  async search(uuid: string, requested: string, term: string): Promise<AgentFileEntry[]> {
    const root = await this.paths.resolveChecked(uuid, requested);
    const needle = term.toLowerCase();
    const results: AgentFileEntry[] = [];

    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_SEARCH_DEPTH || results.length >= MAX_SEARCH_RESULTS) return;

      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (results.length >= MAX_SEARCH_RESULTS) return;
        const absolute = path.join(directory, entry.name);

        if (entry.name.toLowerCase().includes(needle)) {
          const info = await fs.lstat(absolute).catch(() => null);
          if (info) {
            results.push({
              name: entry.name,
              path: this.paths.relative(uuid, absolute),
              size: info.size,
              isDirectory: info.isDirectory(),
              isFile: info.isFile(),
              isSymlink: info.isSymbolicLink(),
              mimeType: info.isDirectory()
                ? 'inode/directory'
                : (MIME_TYPES[path.extname(entry.name).toLowerCase()] ??
                  'application/octet-stream'),
              mode: (info.mode & 0o777).toString(8).padStart(3, '0'),
              modifiedAt: info.mtime.toISOString(),
              createdAt: info.birthtime.toISOString(),
            });
          }
        }

        // Symlinks are never followed during a walk: they could point anywhere.
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          await walk(absolute, depth + 1);
        }
      }
    };

    await walk(root, 0);
    return results;
  }

  /** Total size of a server directory, used for disk reporting. */
  async directorySize(uuid: string): Promise<number> {
    const root = this.paths.root(uuid);
    let total = 0;

    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 20) return;
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(absolute, depth + 1);
        } else {
          const info = await fs.lstat(absolute).catch(() => null);
          total += info?.size ?? 0;
        }
      }
    };

    await walk(root, 0);
    return total;
  }

  private async exists(target: string): Promise<boolean> {
    return fs
      .access(target)
      .then(() => true)
      .catch(() => false);
  }

  /** Keeps new files owned by the uid the game container runs as. */
  private async own(target: string): Promise<void> {
    await fs.chown(target, 1000, 1000).catch(() => undefined);
  }
}
