import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { Permission, TemplateFeature } from '@storm/types';
import { body, params, query } from '../lib/validation.js';
import { ok } from '../lib/response.js';
import { badRequest, notFound } from '../lib/errors.js';
import { ServerAccessService } from '../services/server-access.service.js';
import {
  MAX_MRPACK_BYTES,
  SUPPORTED_LOADER,
  type ModpackPlan,
} from '../services/modpack-registry.service.js';
import type { ServerAccess } from '../services/server-access.service.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

/** Where the pack archive is unpacked before its overrides are moved into place. */
const STAGING_DIRECTORY = '/.storm-modpack';

/** Both names a `.mrpack` may use for the files it wants copied over the server. */
const OVERRIDE_DIRECTORIES = ['overrides', 'server-overrides'] as const;

/**
 * Browsing and installing Minecraft modpacks.
 *
 * The two rules that shape this file:
 *
 * **The panel resolves every address.** A modpack index is a list of download
 * URLs written by a third party. They are all checked here, against an
 * allowlist and against the addresses no outbound request should ever reach,
 * and only the ones that pass are handed to a node.
 *
 * **A pack is never installed onto a server that cannot run it.** Installing
 * a Fabric pack into a Paper server writes a hundred mods the server will
 * ignore, and installing one at a different Minecraft version writes mods that
 * crash it on start. Both are refused, by name, with what to change — rather
 * than switching the customer's server type underneath them, which would mean
 * a reinstall and a lost world.
 */
export default async function modpackRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  /** Resolves the server and refuses if modpacks are not its business. */
  async function requireModpackServer(
    request: Parameters<typeof app.authenticate>[0],
    permission: string,
  ): Promise<ServerAccess> {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const access = await app.serverAccess.require(user, id, permission);

    const features = (access.server.template?.features ?? []) as string[];
    if (!features.includes(TemplateFeature.MODPACKS)) {
      // 404 rather than 403: the endpoint does not exist for this server.
      throw notFound('This server does not use modpacks');
    }
    return access;
  }

  /** A startup variable's current value on this server, or the empty string. */
  function variable(access: ServerAccess, key: string): string {
    const found = (access.server.variables ?? []).find(
      (entry: { key: string }) => entry.key === key,
    );
    return typeof found?.value === 'string' ? found.value : '';
  }

  /* --------------------------------------------------------- browsing -- */

  app.get(
    '/:id/modpacks/search',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { tags: ['Modpacks'], summary: 'Search the modpack registry' },
    },
    async (request) => {
      await requireModpackServer(request, Permission.SERVERS_FILES);
      const q = query(
        request,
        z.object({
          q: z.string().trim().max(120).default(''),
          gameVersion: z
            .string()
            .trim()
            .regex(/^[0-9][0-9.]{0,15}$/, 'Use a Minecraft version like 1.21.4')
            .optional(),
        }),
      );

      return ok(await app.modpacks.search(q.q, q.gameVersion));
    },
  );

  app.get(
    '/:id/modpacks/:projectId/versions',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { tags: ['Modpacks'], summary: 'Published builds of a modpack' },
    },
    async (request) => {
      await requireModpackServer(request, Permission.SERVERS_FILES);
      const { projectId } = params(
        request,
        idParam.extend({ projectId: z.string().min(1).max(64) }),
      );
      const q = query(
        request,
        z.object({
          gameVersion: z
            .string()
            .trim()
            .regex(/^[0-9][0-9.]{0,15}$/)
            .optional(),
        }),
      );

      return ok(await app.modpacks.versions(projectId, q.gameVersion));
    },
  );

  /* -------------------------------------------------------- installing -- */

  app.post(
    '/:id/modpacks',
    {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
      schema: { tags: ['Modpacks'], summary: 'Install a modpack' },
    },
    async (request) => {
      const access = await requireModpackServer(request, Permission.SERVERS_FILES_WRITE);
      ServerAccessService.assertNotSuspended(access);
      await app.servers.assertDiskWithinLimit(access.server);

      // A pack rewrites mods and configs under the server while it is reading
      // them. Requiring it stopped is not caution — a running server holds its
      // jars open and writes its configs back over yours on shutdown.
      if (access.server.status !== 'OFFLINE') {
        throw badRequest('Stop the server before installing a modpack');
      }

      const input = body(request, z.object({ versionId: z.string().min(1).max(64) }));
      const plan = await app.modpacks.resolvePlan(input.versionId);

      assertServerCanRun(plan, variable(access, 'PROJECT'), variable(access, 'MINECRAFT_VERSION'));

      const uuid = access.server.uuid as string;
      const node = access.server.node;
      const agent = <T>(path: string, options: Record<string, unknown>): Promise<T> =>
        app.agents.request<T>(node, `/api/v1/servers/${uuid}${path}`, options);

      /* ------ overrides first, so the pack's own mods folder lands before
                the individual mods are fetched into it -- */

      const packFilename = 'pack.mrpack';
      await agent('/files/fetch', {
        method: 'POST',
        body: {
          url: plan.packUrl,
          path: `${STAGING_DIRECTORY}/${packFilename}`,
          sha512: plan.packSha512,
          maxBytes: MAX_MRPACK_BYTES,
        },
        timeoutMs: 10 * 60_000,
      });

      await agent('/files/decompress', {
        method: 'POST',
        body: { path: STAGING_DIRECTORY, file: packFilename },
        timeoutMs: 10 * 60_000,
      });

      const kept: string[] = [];
      for (const directory of OVERRIDE_DIRECTORIES) {
        const listing = await agent<{ entries: { name: string }[] }>('/files/list', {
          query: { path: `${STAGING_DIRECTORY}/${directory}` },
        }).catch(() => ({ entries: [] }));

        for (const entry of listing.entries) {
          // Moved one top level at a time, so a pack that ships `config/` and
          // `mods/` costs two moves rather than one per file. A name that is
          // already taken is kept, not overwritten: the customer's own
          // server.properties outranks the pack author's.
          await agent('/files/rename', {
            method: 'POST',
            body: { from: `${STAGING_DIRECTORY}/${directory}/${entry.name}`, to: `/${entry.name}` },
          }).catch(() => kept.push(entry.name));
        }
      }

      /* ------------------------------------------------------- the mods -- */

      for (const file of plan.files) {
        await agent('/files/fetch', {
          method: 'POST',
          body: {
            url: file.url,
            path: `/${file.path}`,
            sha512: file.sha512,
            maxBytes: MAX_MRPACK_BYTES,
          },
          timeoutMs: 10 * 60_000,
        });
      }

      await agent('/files/delete', {
        method: 'POST',
        body: { paths: [STAGING_DIRECTORY] },
      }).catch(() => undefined);

      await app.audit.activity(request, {
        serverId: access.server.id,
        event: 'modpack:installed',
        metadata: {
          name: plan.name,
          versionId: input.versionId,
          version: plan.versionNumber,
          minecraft: plan.minecraft,
          files: plan.files.length,
        },
      });

      return ok({
        name: plan.name,
        version: plan.versionNumber,
        minecraft: plan.minecraft,
        loaderVersion: plan.loaderVersion,
        installed: plan.files.length,
        skippedClientOnly: plan.skippedClientOnly,
        keptExisting: kept,
        message: 'Installed. Start the server to load the pack.',
      });
    },
  );
}

/**
 * Refuses a pack the server as configured cannot run.
 *
 * Exported for the tests, which is the point: the rule is the whole safety of
 * this feature. A Fabric pack in a Paper server is a hundred jars the server
 * ignores and a customer who thinks the panel is broken; a pack for a
 * different Minecraft version is mods that crash the server on start.
 */
export function assertServerCanRun(
  plan: ModpackPlan,
  project: string,
  minecraftVersion: string,
): void {
  if (project.toLowerCase() !== SUPPORTED_LOADER) {
    throw badRequest(
      `This server runs ${project || 'no configured project'}, and the pack needs ` +
        `${SUPPORTED_LOADER}. Change Project to ${SUPPORTED_LOADER} on the Startup tab and ` +
        'reinstall the server first — reinstalling erases its files, so back it up if it has a world worth keeping.',
    );
  }

  // "latest" is not a version, it is an instruction, and it resolves to
  // whatever was newest at install time. Comparing against it would either
  // reject every pack or accept every pack, so it is treated as "unpinned"
  // and the customer is told to pin it.
  if (minecraftVersion === 'latest' || minecraftVersion === '') {
    throw badRequest(
      `Set Minecraft Version to ${plan.minecraft} on the Startup tab before installing this ` +
        'pack. While it is "latest" the panel cannot tell whether the installed server matches the pack.',
    );
  }

  if (minecraftVersion !== plan.minecraft) {
    throw badRequest(
      `This server runs Minecraft ${minecraftVersion} and the pack is built for ` +
        `${plan.minecraft}. Pick a build of the pack for ${minecraftVersion}, or change the ` +
        'version on the Startup tab and reinstall first.',
    );
  }
}
