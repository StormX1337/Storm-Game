import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  ErrorCode,
  Permission,
  ServerStatus,
  TemplateFeature,
  banIpSchema,
  minecraftUsername,
  playerActionSchema,
  whitelistToggleSchema,
} from '@storm/types';
import { body, params } from '../lib/validation.js';
import { ok } from '../lib/response.js';
import { AppError, notFound } from '../lib/errors.js';
import { ServerAccessService } from '../services/server-access.service.js';
import type { ServerAccess } from '../services/server-access.service.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

export interface OperatorEntry {
  uuid: string;
  name: string;
  level: number;
}

export interface BanEntry {
  name: string;
  reason: string;
  created: string | null;
  expires: string | null;
  source: string;
}

/**
 * Operators, the whitelist and bans.
 *
 * Reading comes from the files Minecraft keeps beside the world. Writing does
 * not touch them: a running server holds these lists in memory and rewrites
 * the files itself, so editing one underneath is either ignored or silently
 * undone at shutdown — the worst kind of failure, because the panel would show
 * the change and the game would not have it. Every change is therefore the
 * console command the game already understands, which also means the server
 * has to be running, and this says so plainly rather than pretending.
 */
export default async function playerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  async function requirePlayerServer(
    request: Parameters<typeof app.authenticate>[0],
    permission: string,
  ): Promise<ServerAccess> {
    const user = request.currentUser();
    const { id } = params(request, idParam);
    const access = await app.serverAccess.require(user, id, permission);

    const features = (access.server.template?.features ?? []) as string[];
    if (!features.includes(TemplateFeature.PLAYERS)) {
      throw notFound('This server does not manage players this way');
    }
    return access;
  }

  /** Reads one of Minecraft's JSON files; a missing file means an empty list. */
  async function readJson<T>(access: ServerAccess, file: string): Promise<T[]> {
    const response = await app.agents
      .request<{
        content: string;
      }>(access.server.node, `/api/v1/servers/${access.server.uuid}/files/contents`, {
        query: { path: `/${file}` },
      })
      .catch(() => null);
    if (!response) return [];

    try {
      const parsed: unknown = JSON.parse(response.content);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      // A half-written file during a crash is not worth failing the page over.
      return [];
    }
  }

  /**
   * Whether the whitelist is actually enforced.
   *
   * The list and the switch are separate things in Minecraft: `whitelist.json`
   * says who may join, `white-list` in server.properties says whether that is
   * consulted at all. Showing the list without the switch would let someone
   * curate a whitelist that does nothing.
   */
  async function whitelistEnforced(access: ServerAccess): Promise<boolean> {
    const response = await app.agents
      .request<{
        content: string;
      }>(access.server.node, `/api/v1/servers/${access.server.uuid}/files/contents`, {
        query: { path: '/server.properties' },
      })
      .catch(() => null);
    if (!response) return false;

    return /^white-list\s*=\s*true\s*$/m.test(response.content);
  }

  /**
   * Runs a console command on the server's behalf.
   *
   * The command is assembled here from values the schemas have already
   * constrained to a single line — nothing a caller sends can add a second.
   */
  async function run(access: ServerAccess, command: string): Promise<void> {
    if (
      access.server.status !== ServerStatus.ONLINE &&
      access.server.status !== ServerStatus.STARTING
    ) {
      throw new AppError(
        409,
        ErrorCode.SERVER_BUSY,
        'The server has to be running to change this. Minecraft owns these lists while it runs, ' +
          'so the panel asks it rather than editing the files underneath it.',
      );
    }

    await app.agents.request(access.server.node, `/api/v1/servers/${access.server.uuid}/command`, {
      method: 'POST',
      body: { command },
    });
  }

  /* ------------------------------------------------------------ reading -- */

  app.get(
    '/:id/players',
    { schema: { tags: ['Players'], summary: 'Operators, whitelist and bans' } },
    async (request) => {
      const access = await requirePlayerServer(request, Permission.SERVERS_PLAYERS);

      const [operators, whitelist, bans, ipBans, whitelistEnabled] = await Promise.all([
        readJson<{ uuid: string; name: string; level?: number }>(access, 'ops.json'),
        readJson<{ uuid: string; name: string }>(access, 'whitelist.json'),
        readJson<Record<string, string>>(access, 'banned-players.json'),
        readJson<Record<string, string>>(access, 'banned-ips.json'),
        whitelistEnforced(access),
      ]);

      return ok({
        // The files are what the game last wrote, so while it runs they can be
        // a moment behind. Saying so beats implying they are live.
        live: access.server.status === ServerStatus.ONLINE,
        operators: operators.map((entry) => ({
          uuid: entry.uuid,
          name: entry.name,
          level: entry.level ?? 4,
        })),
        whitelistEnabled,
        whitelist: whitelist.map((entry) => ({ uuid: entry.uuid, name: entry.name })),
        bans: bans.map(toBan),
        ipBans: ipBans.map((entry) => ({
          ip: entry.ip ?? '',
          reason: entry.reason ?? '',
          created: entry.created ?? null,
          expires: entry.expires === 'forever' ? null : (entry.expires ?? null),
          source: entry.source ?? '',
        })),
      });
    },
  );

  /* ----------------------------------------------------------- changing -- */

  const nameParam = idParam.extend({ name: minecraftUsername });

  app.post(
    '/:id/players/operators',
    { schema: { tags: ['Players'], summary: 'Give a player operator status' } },
    async (request) => {
      const access = await requirePlayerServer(request, Permission.SERVERS_PLAYERS);
      ServerAccessService.assertNotSuspended(access);
      const { name } = body(request, playerActionSchema);

      await run(access, `op ${name}`);
      await app.audit.activity(request, {
        serverId: access.server.id,
        event: 'player:opped',
        metadata: { name },
      });
      return ok({ name, message: `${name} is now an operator.` });
    },
  );

  app.delete(
    '/:id/players/operators/:name',
    { schema: { tags: ['Players'], summary: 'Take operator status away' } },
    async (request) => {
      const access = await requirePlayerServer(request, Permission.SERVERS_PLAYERS);
      ServerAccessService.assertNotSuspended(access);
      const { name } = params(request, nameParam);

      await run(access, `deop ${name}`);
      await app.audit.activity(request, {
        serverId: access.server.id,
        event: 'player:deopped',
        metadata: { name },
      });
      return ok({ name, message: `${name} is no longer an operator.` });
    },
  );

  app.post(
    '/:id/players/whitelist',
    { schema: { tags: ['Players'], summary: 'Add a player to the whitelist' } },
    async (request) => {
      const access = await requirePlayerServer(request, Permission.SERVERS_PLAYERS);
      ServerAccessService.assertNotSuspended(access);
      const { name } = body(request, playerActionSchema);

      await run(access, `whitelist add ${name}`);
      await app.audit.activity(request, {
        serverId: access.server.id,
        event: 'player:whitelisted',
        metadata: { name },
      });
      return ok({ name, message: `${name} may join.` });
    },
  );

  app.delete(
    '/:id/players/whitelist/:name',
    { schema: { tags: ['Players'], summary: 'Remove a player from the whitelist' } },
    async (request) => {
      const access = await requirePlayerServer(request, Permission.SERVERS_PLAYERS);
      ServerAccessService.assertNotSuspended(access);
      const { name } = params(request, nameParam);

      await run(access, `whitelist remove ${name}`);
      return ok({ name, message: `${name} was removed from the whitelist.` });
    },
  );

  app.post(
    '/:id/players/whitelist/enabled',
    { schema: { tags: ['Players'], summary: 'Turn the whitelist on or off' } },
    async (request) => {
      const access = await requirePlayerServer(request, Permission.SERVERS_PLAYERS);
      ServerAccessService.assertNotSuspended(access);
      const { enabled } = body(request, whitelistToggleSchema);

      await run(access, `whitelist ${enabled ? 'on' : 'off'}`);
      await app.audit.activity(request, {
        serverId: access.server.id,
        event: 'player:whitelist_toggled',
        metadata: { enabled },
      });
      return ok({
        enabled,
        message: enabled
          ? 'Only whitelisted players may join.'
          : 'Anyone may join. The list is kept.',
      });
    },
  );

  app.post(
    '/:id/players/bans',
    { schema: { tags: ['Players'], summary: 'Ban a player' } },
    async (request) => {
      const access = await requirePlayerServer(request, Permission.SERVERS_PLAYERS);
      ServerAccessService.assertNotSuspended(access);
      const { name, reason } = body(request, playerActionSchema);

      await run(access, reason ? `ban ${name} ${reason}` : `ban ${name}`);
      await app.audit.activity(request, {
        serverId: access.server.id,
        event: 'player:banned',
        metadata: { name, reason: reason ?? null },
      });
      return ok({ name, message: `${name} is banned.` });
    },
  );

  app.delete(
    '/:id/players/bans/:name',
    { schema: { tags: ['Players'], summary: 'Lift a ban' } },
    async (request) => {
      const access = await requirePlayerServer(request, Permission.SERVERS_PLAYERS);
      ServerAccessService.assertNotSuspended(access);
      const { name } = params(request, nameParam);

      await run(access, `pardon ${name}`);
      await app.audit.activity(request, {
        serverId: access.server.id,
        event: 'player:pardoned',
        metadata: { name },
      });
      return ok({ name, message: `${name} may join again.` });
    },
  );

  app.post(
    '/:id/players/ip-bans',
    { schema: { tags: ['Players'], summary: 'Ban an address' } },
    async (request) => {
      const access = await requirePlayerServer(request, Permission.SERVERS_PLAYERS);
      ServerAccessService.assertNotSuspended(access);
      const { ip, reason } = body(request, banIpSchema);

      await run(access, reason ? `ban-ip ${ip} ${reason}` : `ban-ip ${ip}`);
      await app.audit.activity(request, {
        serverId: access.server.id,
        event: 'player:ip_banned',
        metadata: { ip },
      });
      return ok({ ip, message: `${ip} is banned.` });
    },
  );

  app.delete(
    '/:id/players/ip-bans/:ip',
    { schema: { tags: ['Players'], summary: 'Lift an address ban' } },
    async (request) => {
      const access = await requirePlayerServer(request, Permission.SERVERS_PLAYERS);
      ServerAccessService.assertNotSuspended(access);
      const { ip } = params(request, idParam.extend({ ip: z.string().trim().ip() }));

      await run(access, `pardon-ip ${ip}`);
      return ok({ ip, message: `${ip} may connect again.` });
    },
  );

  app.post(
    '/:id/players/kick',
    { schema: { tags: ['Players'], summary: 'Kick a player who is on now' } },
    async (request) => {
      const access = await requirePlayerServer(request, Permission.SERVERS_PLAYERS);
      ServerAccessService.assertNotSuspended(access);
      const { name, reason } = body(request, playerActionSchema);

      await run(access, reason ? `kick ${name} ${reason}` : `kick ${name}`);
      await app.audit.activity(request, {
        serverId: access.server.id,
        event: 'player:kicked',
        metadata: { name },
      });
      return ok({ name, message: `${name} was kicked.` });
    },
  );
}

/** Minecraft writes `expires: "forever"` rather than leaving it out. */
function toBan(entry: Record<string, string>): BanEntry {
  return {
    name: entry.name ?? '',
    reason: entry.reason ?? '',
    created: entry.created ?? null,
    expires: entry.expires === 'forever' ? null : (entry.expires ?? null),
    source: entry.source ?? '',
  };
}
