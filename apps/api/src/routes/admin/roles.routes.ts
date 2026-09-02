import type { FastifyInstance } from 'fastify';
import {
  ALL_PERMISSIONS,
  PERMISSION_DEFINITIONS,
  Permission,
  ROLE_PERMISSIONS,
  type RoleName,
} from '@storm/types';
import { ok } from '../../lib/response.js';

/**
 * What each role can do, read out of the database rather than assumed.
 *
 * The panel has had five roles and forty-odd permissions since the first
 * version, all of them enforced on every request and none of them visible
 * anywhere. An operator could not answer "what does STAFF actually get?"
 * without opening psql, and could not tell that a role was short of a
 * permission the seed had since added.
 *
 * So this reports both: the grants the database holds, and how they differ
 * from what the seed intends. Drift between the two is silent and it is the
 * reason a freshly added permission appears to do nothing — the seed has it,
 * the deployment never re-ran it.
 */
export default async function adminRoleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.requirePermission(Permission.USERS_MANAGE));

  app.get(
    '/',
    { schema: { tags: ['Admin: Roles'], summary: 'Roles, their grants, and any drift' } },
    async () => {
      const roles = await app.prisma.role.findMany({
        include: { permissions: true, _count: { select: { users: true } } },
        orderBy: { priority: 'desc' },
      });

      return ok(
        roles.map((role) => {
          const held = new Set(role.permissions.map((permission) => permission.key));
          const intended = new Set<string>(ROLE_PERMISSIONS[role.name as RoleName] ?? []);

          return {
            id: role.id,
            name: role.name,
            displayName: role.displayName,
            description: role.description,
            priority: role.priority,
            isSystem: role.isSystem,
            userCount: role._count.users,
            permissions: [...held].sort(),
            // Named from the deployment's point of view: "missing" is what a
            // re-seed would add, "unexpected" is what somebody granted by hand.
            missing: [...intended].filter((key) => !held.has(key)).sort(),
            unexpected: [...held].filter((key) => !intended.has(key)).sort(),
          };
        }),
      );
    },
  );

  app.get(
    '/permissions',
    { schema: { tags: ['Admin: Roles'], summary: 'Every permission the panel enforces' } },
    async () => {
      // Straight from the definitions the auth layer checks against, so the
      // list cannot describe a permission that is not real or miss one that is.
      const described = new Map(
        PERMISSION_DEFINITIONS.map((definition) => [definition.key as string, definition]),
      );

      return ok(
        ALL_PERMISSIONS.map((key) => ({
          key,
          category: described.get(key)?.category ?? 'other',
          description: described.get(key)?.description ?? '',
        })),
      );
    },
  );
}
