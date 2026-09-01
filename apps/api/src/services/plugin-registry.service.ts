import { request } from 'undici';
import type { FastifyInstance } from 'fastify';
import { assertSafeUrl, sanitizeFilename } from '@storm/security';
import { ErrorCode } from '@storm/types';
import { AppError, badRequest } from '../lib/errors.js';

/** A plugin as the browser lists it. */
export interface PluginSearchResult {
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

/** One downloadable build of a plugin. */
export interface PluginVersion {
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

/** What a version resolves to once the panel has checked it. */
export interface ResolvedDownload {
  url: string;
  filename: string;
  sha512: string | undefined;
  bytes: number;
}

/** Anything bigger than this is not a plugin. */
export const MAX_PLUGIN_BYTES = 256 * 1024 * 1024;

/**
 * The loaders a jar in `plugins/` can actually be loaded by.
 *
 * Filtering by project type instead of this is what put Fabric API and Sodium
 * in front of someone running Paper: Modrinth calls them mods, they are mods,
 * and dropping one in `plugins/` does exactly nothing. What decides whether a
 * jar works is which loader built it, so that is what is asked for.
 */
export const BUKKIT_LOADERS = ['bukkit', 'spigot', 'paper', 'purpur', 'folia'] as const;

/** True when a build was made for something in the Bukkit family. */
export function loadableAsPlugin(loaders: string[]): boolean {
  return loaders.some((loader) =>
    (BUKKIT_LOADERS as readonly string[]).includes(loader.toLowerCase()),
  );
}

/**
 * The plugin browser's connection to Modrinth.
 *
 * The rule that matters here: **a customer never supplies a URL.** They name a
 * version, this resolves the download from the registry, and the result is
 * checked against a host allowlist before any node is asked to fetch it.
 *
 * Without that, "install this plugin" is a way to make a node request an
 * arbitrary address — its own metadata service, something on the operator's
 * private network — and write the answer into a directory the customer can
 * then read through the file manager. The customer's input is an opaque id,
 * and the panel decides what it points at.
 */
export class PluginRegistryService {
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
      // A panel with no route to the registry is a normal state — an offline
      // install, a locked-down network — and should read as that rather than
      // as the panel being broken.
      throw new AppError(
        502,
        ErrorCode.SERVICE_UNAVAILABLE,
        `The plugin registry could not be reached: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    if (response.statusCode === 404) throw badRequest('That plugin no longer exists');
    if (response.statusCode >= 400) {
      throw new AppError(
        502,
        ErrorCode.SERVICE_UNAVAILABLE,
        `The plugin registry answered ${response.statusCode}`,
      );
    }
    return (await response.body.json()) as T;
  }

  /** Plugins matching a search, newest and most used first. */
  async search(query: string, gameVersion?: string): Promise<PluginSearchResult[]> {
    // Facets are AND across groups and OR inside one, so this reads: built for
    // any of the Bukkit-family loaders, and for this Minecraft version.
    const facets: string[][] = [BUKKIT_LOADERS.map((loader) => `categories:${loader}`)];
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
      pageUrl: `https://modrinth.com/plugin/${hit.slug}`,
    }));
  }

  /** The builds of one plugin, newest first. */
  async versions(projectId: string, gameVersion?: string): Promise<PluginVersion[]> {
    const payload = await this.get<ModrinthVersion[]>(`/project/${projectId}/version`);

    return (
      payload
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
        // A project can carry builds for several loaders. Offering the Fabric one
        // to a Paper server would install a jar the server silently ignores.
        .filter((version) => version.filename.endsWith('.jar') && loadableAsPlugin(version.loaders))
    );
  }

  /**
   * Turns a version id into something a node may be told to download.
   *
   * Everything the node is handed comes from here, never from the request.
   */
  async resolveDownload(versionId: string): Promise<ResolvedDownload> {
    const version = await this.get<ModrinthVersion>(`/version/${versionId}`);
    const file = primaryFile(version);
    if (!file) throw badRequest('That version has no downloadable file');

    if (!loadableAsPlugin(version.loaders)) {
      throw badRequest(
        `That build is for ${version.loaders.join(', ') || 'no known loader'}, which a plugins ` +
          'folder cannot load. Pick a Paper, Spigot or Bukkit build.',
      );
    }

    const filename = sanitizeFilename(file.filename);
    if (!filename.toLowerCase().endsWith('.jar')) {
      throw badRequest('That version is not a plugin jar');
    }
    if (file.size > MAX_PLUGIN_BYTES) {
      throw badRequest(`That file is larger than ${MAX_PLUGIN_BYTES} bytes`);
    }

    // Where the registry says the bytes live, checked twice: once against the
    // hosts an operator allows, and once against addresses no outbound request
    // should ever reach.
    const url = await assertSafeUrl(file.url, { allowedProtocols: ['https:'] }).catch(() => {
      throw badRequest('The registry pointed at an address the panel will not fetch');
    });
    if (!this.allowedHosts.includes(url.hostname.toLowerCase())) {
      throw badRequest(`Plugin downloads are only accepted from ${this.allowedHosts.join(', ')}`);
    }

    return {
      url: url.toString(),
      filename,
      sha512: file.hashes?.sha512,
      bytes: file.size,
    };
  }
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

declare module 'fastify' {
  interface FastifyInstance {
    plugins: PluginRegistryService;
  }
}
