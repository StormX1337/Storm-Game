import { Buffer } from 'node:buffer';
import { request } from 'undici';
import unzipper from 'unzipper';
import type { FastifyInstance } from 'fastify';
import { assertSafeUrl } from '@storm/security';
import { ErrorCode, MODPACK_LOADER } from '@storm/types';
import { AppError, badRequest } from '../lib/errors.js';

/** A modpack as the browser lists it. */
export interface ModpackSearchResult {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  downloads: number;
  followers: number;
  iconUrl: string | null;
  categories: string[];
  pageUrl: string;
}

/** One published build of a modpack. */
export interface ModpackVersion {
  versionId: string;
  name: string;
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
  releaseType: string;
  publishedAt: string;
  filename: string;
  bytes: number;
}

/** One file the pack wants on disk, after the panel has vetted it. */
export interface ModpackFile {
  url: string;
  path: string;
  sha512: string | undefined;
  bytes: number;
}

/** Everything a node needs to build the pack, and nothing it has to trust. */
export interface ModpackPlan {
  name: string;
  versionNumber: string;
  minecraft: string;
  loaderVersion: string;
  /** The `.mrpack` itself, for the overrides inside it. */
  packUrl: string;
  packBytes: number;
  packSha512: string | undefined;
  files: ModpackFile[];
  totalBytes: number;
  /** Client-only files that were left out, named so the customer can see why. */
  skippedClientOnly: string[];
}

/** A `.mrpack` is an index and some config; anything larger is not one. */
export const MAX_MRPACK_BYTES = 64 * 1024 * 1024;

/** The mods a pack may pull, in total. A server disk limit still applies. */
export const MAX_MODPACK_TOTAL_BYTES = 6 * 1024 * 1024 * 1024;

/** More files than any real pack has; a defence against an index bomb. */
export const MAX_MODPACK_FILES = 1000;

/**
 * The only loader the panel can install a pack for.
 *
 * Not a preference. Fabric's meta API hands out a launchable server jar, so a
 * Fabric server starts from the same command line as a vanilla one. Forge,
 * NeoForge and Quilt ship an installer that has to be run first and then
 * started through a different command line entirely, which the Minecraft
 * template cannot express — so a pack built for one of those is refused by
 * name rather than installed into a server that will never load it.
 *
 * The value lives in `@storm/types`, where the panel reads it too.
 */
export const SUPPORTED_LOADER = MODPACK_LOADER;

/**
 * The modpack browser's connection to Modrinth.
 *
 * The rule from the plugin browser holds here and matters more: **a customer
 * never supplies a URL.** They name a version; the panel resolves it, opens
 * the `.mrpack` itself, and checks every single download inside it before any
 * node is told to fetch anything.
 *
 * A modpack index is a list of URLs written by a third party, which is a
 * different thing from a plugin's single download. Handing that list to a node
 * unchecked would turn "install this modpack" into "make my node fetch these
 * hundred addresses" — its own metadata service, something on the operator's
 * private network — and write the answers into a directory the customer can
 * read back through the file manager. So every entry is checked here, and the
 * node only ever receives addresses that passed.
 */
export class ModpackRegistryService {
  constructor(private readonly app: FastifyInstance) {}

  private get base(): string {
    return this.app.env.MODRINTH_API_URL.replace(/\/+$/, '');
  }

  private get allowedHosts(): string[] {
    return this.app.env.MODRINTH_DOWNLOAD_HOSTS.split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
  }

  private async get<T>(path: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

    let response;
    try {
      response = await request(url, {
        method: 'GET',
        headers: { 'user-agent': 'StormPanel/1.0 (self-hosted game panel)' },
        headersTimeout: 15_000,
        bodyTimeout: 30_000,
      });
    } catch (error) {
      throw new AppError(
        502,
        ErrorCode.SERVICE_UNAVAILABLE,
        `The modpack registry could not be reached: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    if (response.statusCode === 404) throw badRequest('That modpack no longer exists');
    if (response.statusCode >= 400) {
      throw new AppError(
        502,
        ErrorCode.SERVICE_UNAVAILABLE,
        `The modpack registry answered ${response.statusCode}`,
      );
    }
    return (await response.body.json()) as T;
  }

  /** Modpacks matching a search, most used first when nothing was typed. */
  async search(query: string, gameVersion?: string): Promise<ModpackSearchResult[]> {
    // Facets are AND across groups and OR inside one. Both are needed: without
    // the loader facet the list fills with Forge packs that cannot be
    // installed, and without the project type it fills with individual mods.
    const facets: string[][] = [['project_type:modpack'], [`categories:${SUPPORTED_LOADER}`]];
    if (gameVersion) facets.push([`versions:${gameVersion}`]);

    const payload = await this.get<{ hits: ModrinthHit[] }>('/search', {
      query,
      limit: '30',
      index: query ? 'relevance' : 'downloads',
      facets: JSON.stringify(facets),
    });

    return payload.hits.map((hit) => ({
      projectId: hit.project_id,
      slug: hit.slug,
      title: hit.title,
      description: hit.description,
      downloads: hit.downloads,
      followers: hit.follows,
      iconUrl: hit.icon_url || null,
      categories: hit.categories ?? [],
      pageUrl: `https://modrinth.com/modpack/${hit.slug}`,
    }));
  }

  /** The builds of one modpack, newest first. */
  async versions(projectId: string, gameVersion?: string): Promise<ModpackVersion[]> {
    const payload = await this.get<ModrinthVersion[]>(`/project/${projectId}/version`);

    return payload
      .filter((version) => !gameVersion || version.game_versions.includes(gameVersion))
      .map((version) => {
        const file = primaryFile(version);
        return {
          versionId: version.id,
          name: version.name,
          versionNumber: version.version_number,
          gameVersions: version.game_versions,
          loaders: version.loaders,
          releaseType: version.version_type,
          publishedAt: version.date_published,
          filename: file?.filename ?? '',
          bytes: file?.size ?? 0,
        };
      })
      .filter(
        (version) =>
          version.filename.toLowerCase().endsWith('.mrpack') &&
          version.loaders.some((loader) => loader.toLowerCase() === SUPPORTED_LOADER),
      );
  }

  /**
   * Opens a version's `.mrpack` and turns it into a plan a node may act on.
   *
   * Everything in the returned plan came from here. Nothing in it came from
   * the request, and nothing in it went unchecked.
   */
  async resolvePlan(versionId: string): Promise<ModpackPlan> {
    const version = await this.get<ModrinthVersion>(`/version/${versionId}`);
    const file = primaryFile(version);
    if (!file) throw badRequest('That version has no downloadable file');
    if (!file.filename.toLowerCase().endsWith('.mrpack')) {
      throw badRequest('That version is not a modpack archive');
    }
    if (file.size > MAX_MRPACK_BYTES) {
      throw badRequest('That modpack archive is larger than the panel will open');
    }

    const packUrl = await this.checkedUrl(file.url);
    const index = await this.readIndex(packUrl);

    /* ---------------------------------------------------- the loader -- */

    const dependencies = index.dependencies ?? {};
    const minecraft = typeof dependencies.minecraft === 'string' ? dependencies.minecraft : '';
    const loaderVersion =
      typeof dependencies['fabric-loader'] === 'string' ? dependencies['fabric-loader'] : '';

    if (!loaderVersion) {
      const other = Object.keys(dependencies).filter((key) => key !== 'minecraft');
      throw badRequest(
        other.length > 0
          ? `That pack needs ${other.join(' and ')}, which this panel cannot install. Only Fabric packs can be installed.`
          : 'That pack does not say which loader it needs',
      );
    }
    if (!minecraft) throw badRequest('That pack does not say which Minecraft version it needs');

    /* ----------------------------------------------------- the files -- */

    const entries = Array.isArray(index.files) ? index.files : [];
    if (entries.length > MAX_MODPACK_FILES) {
      throw badRequest(`That pack lists more than ${MAX_MODPACK_FILES} files`);
    }

    const files: ModpackFile[] = [];
    const skippedClientOnly: string[] = [];
    let totalBytes = 0;

    for (const entry of entries) {
      // A pack ships client and server files in one index. Installing a
      // client-only mod on a server is not a harmless extra — it is a mod
      // that crashes the server on load, which reads as the panel breaking it.
      if (entry.env?.server === 'unsupported') {
        skippedClientOnly.push(String(entry.path ?? 'a file'));
        continue;
      }

      const path = safeRelativePath(entry.path);
      const source = Array.isArray(entry.downloads) ? entry.downloads[0] : undefined;
      if (!source) throw badRequest(`The pack lists no download for ${path}`);

      const url = await this.checkedUrl(source);
      const bytes = Number(entry.fileSize ?? 0);
      totalBytes += Number.isFinite(bytes) && bytes > 0 ? bytes : 0;

      files.push({ url, path, sha512: entry.hashes?.sha512, bytes });
    }

    if (totalBytes > MAX_MODPACK_TOTAL_BYTES) {
      throw badRequest('That pack asks for more data than the panel will install in one go');
    }

    return {
      name: index.name || version.name,
      versionNumber: version.version_number,
      minecraft,
      loaderVersion,
      packUrl,
      packBytes: file.size,
      packSha512: file.hashes?.sha512,
      files,
      totalBytes,
      skippedClientOnly,
    };
  }

  /**
   * An address the panel is willing to have a node fetch.
   *
   * Two checks, because they catch different things: `assertSafeUrl` refuses
   * addresses no outbound request should reach at all — loopback, link-local,
   * anything private — and the allowlist refuses public hosts the operator
   * never agreed to.
   */
  private async checkedUrl(candidate: string): Promise<string> {
    const url = await assertSafeUrl(candidate, { allowedProtocols: ['https:'] }).catch(() => {
      throw badRequest('The pack pointed at an address the panel will not fetch');
    });
    if (!this.allowedHosts.includes(url.hostname.toLowerCase())) {
      throw badRequest(
        `Modpack downloads are only accepted from ${this.allowedHosts.join(', ')}, ` +
          `and this pack asks for ${url.hostname}`,
      );
    }
    return url.toString();
  }

  /**
   * How the archive's bytes are fetched.
   *
   * A seam rather than a setting. Every check around it — the protocol, the
   * private-address refusal, the host allowlist — has to run against real
   * addresses to prove anything, and a test cannot serve https from a public
   * one. Replacing this leaves all of that in place and stands in only for the
   * transport.
   */
  fetchArchive: (url: string) => Promise<Buffer> = (url) => this.download(url);

  /** Reads `modrinth.index.json` out of a `.mrpack`, and nothing else. */
  private async readIndex(url: string): Promise<MrpackIndex> {
    const bytes = await this.fetchArchive(url);

    const archive = await unzipper.Open.buffer(bytes).catch(() => {
      throw badRequest('That modpack archive could not be opened');
    });
    const entry = archive.files.find((candidate) => candidate.path === 'modrinth.index.json');
    if (!entry) throw badRequest('That archive is not a Modrinth modpack — it has no index');

    const raw = await entry.buffer();
    try {
      return JSON.parse(raw.toString('utf8')) as MrpackIndex;
    } catch {
      throw badRequest("That modpack's index could not be read");
    }
  }

  /** The real transport: the archive, read with a ceiling on its size. */
  private async download(url: string): Promise<Buffer> {
    let response;
    try {
      response = await request(url, {
        method: 'GET',
        headers: { 'user-agent': 'StormPanel/1.0 (self-hosted game panel)' },
        headersTimeout: 15_000,
        bodyTimeout: 120_000,
        maxRedirections: 3,
      });
    } catch (error) {
      throw new AppError(
        502,
        ErrorCode.SERVICE_UNAVAILABLE,
        `The modpack could not be downloaded: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    if (response.statusCode >= 400) {
      throw new AppError(
        502,
        ErrorCode.SERVICE_UNAVAILABLE,
        `Downloading the modpack answered ${response.statusCode}`,
      );
    }

    // Read with a ceiling rather than buffering whatever arrives: a
    // content-length is a claim, not a promise, and this runs in the panel.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_MRPACK_BYTES) {
        response.body.destroy();
        throw badRequest('That modpack archive is larger than the panel will open');
      }
      chunks.push(buffer);
    }

    return Buffer.concat(chunks);
  }
}

/**
 * A path from a pack index, checked before it becomes a path on a node.
 *
 * The node checks again — every file route resolves against the server
 * directory and refuses to leave it. This is the first of the two, and it
 * exists because the panel should not be composing a hostile path and sending
 * it anywhere, not because the second one is doubted.
 */
export function safeRelativePath(candidate: unknown): string {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw badRequest('The pack lists a file with no path');
  }

  // Backslashes first: a Windows-style separator would otherwise sail past a
  // check for `..` as one opaque segment.
  const normalised = candidate.replace(/\\/g, '/').trim();

  if (normalised.startsWith('/') || /^[A-Za-z]:/.test(normalised)) {
    throw badRequest(`The pack asks for an absolute path: ${candidate}`);
  }

  const segments = normalised.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) throw badRequest('The pack lists a file with no path');
  if (segments.some((segment) => segment === '..')) {
    throw badRequest(`The pack asks for a path outside the server: ${candidate}`);
  }
  if (segments.some((segment) => segment.includes('\0'))) {
    throw badRequest('The pack lists a path containing a null byte');
  }

  return segments.join('/');
}

/** Modrinth marks one file primary; older versions sometimes mark none. */
function primaryFile(version: ModrinthVersion): ModrinthFile | undefined {
  return version.files?.find((file) => file.primary) ?? version.files?.[0];
}

interface ModrinthHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  downloads: number;
  follows: number;
  icon_url?: string;
  categories?: string[];
}

interface ModrinthFile {
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  hashes?: { sha512?: string; sha1?: string };
}

interface ModrinthVersion {
  id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  version_type: string;
  date_published: string;
  files: ModrinthFile[];
}

interface MrpackIndex {
  name?: string;
  dependencies?: Record<string, unknown>;
  files?: {
    path?: unknown;
    downloads?: unknown;
    fileSize?: unknown;
    hashes?: { sha512?: string; sha1?: string };
    env?: { client?: string; server?: string };
  }[];
}

declare module 'fastify' {
  interface FastifyInstance {
    modpacks: ModpackRegistryService;
  }
}
