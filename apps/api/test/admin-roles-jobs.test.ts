import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ALL_PERMISSIONS, Permission, ROLE_PERMISSIONS } from '@storm/types';
import { hashPassword } from '@storm/security';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * The two administration sections that had no way in, and the security control
 * that had no way to set it.
 *
 * All three are the same defect wearing different clothes: something the panel
 * enforces on every request, with nothing anywhere to look at it or change it.
 * The roles were invisible, the failed jobs were unreachable, and the deny list
 * was subtracted from every permission check while being unsettable outside of
 * psql.
 */
describe('administration: roles, jobs and permission overrides', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let adminToken: string;
  let customer: RegisteredUser;
  const createdUsers: string[] = [];

  const admin = () => ({ authorization: `Bearer ${adminToken}` });
  const asCustomer = () => ({ authorization: `Bearer ${customer.accessToken}` });

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    customer = await registerUser(app);
    createdUsers.push(customer.id);

    const suffix = uniqueSuffix();
    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const owner = await app.prisma.user.create({
      data: {
        email: `adm-owner-${suffix}@storm.test`,
        username: `admowner${suffix}`,
        passwordHash: await hashPassword('OwnerPassword123!'),
        roleId: ownerRole.id,
        emailVerifiedAt: new Date(),
      },
    });
    createdUsers.push(owner.id);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: owner.email, password: 'OwnerPassword123!' },
    });
    adminToken = login.json<{ data: { accessToken: string } }>().data.accessToken;
  });

  after(async () => {
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  /* ----------------------------------------------------------------- roles -- */

  it('describes every permission the panel actually enforces', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/roles/permissions',
      headers: admin(),
    });
    assert.equal(response.statusCode, 200, response.body);

    const rows = response.json<{ data: { key: string; description: string }[] }>().data;
    const described = new Set(rows.map((row) => row.key));

    // A permission the checks use but the catalogue omits cannot be granted or
    // denied through the panel, and nothing else would say so.
    for (const key of ALL_PERMISSIONS) {
      assert.ok(described.has(key), `${key} is enforced but not described`);
    }
    assert.equal(rows.length, ALL_PERMISSIONS.length, 'the catalogue invented a permission');
    assert.ok(
      rows.every((row) => row.description.length > 0),
      'every permission needs a description an operator can read',
    );
  });

  it('reports what each role holds, and how it differs from the seed', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/roles',
      headers: admin(),
    });
    assert.equal(response.statusCode, 200, response.body);

    const roles = response.json<{
      data: { name: string; userCount: number; permissions: string[]; missing: string[] }[];
    }>().data;

    const staff = roles.find((role) => role.name === 'STAFF');
    assert.ok(staff, 'the STAFF role is missing');
    // A freshly seeded database holds exactly what the seed intends, so there
    // is nothing to report. Drift is the interesting case and it is next.
    assert.deepEqual(staff.missing, [], `STAFF is short of: ${staff.missing.join(', ')}`);
    assert.deepEqual(
      [...staff.permissions].sort(),
      [...ROLE_PERMISSIONS.STAFF].sort(),
      'what STAFF holds is not what the seed grants it',
    );
  });

  it('names the grants a deployment never seeded', async () => {
    // Exactly what an update that adds a permission looks like against a
    // deployment that never re-ran the seed: the role is short of it, every
    // check against it quietly fails, and nothing anywhere says why.
    const role = await app.prisma.role.findUniqueOrThrow({
      where: { name: 'STAFF' },
      include: { permissions: true },
    });
    const removed = role.permissions.find((entry) => entry.key === Permission.AUDIT_VIEW);
    assert.ok(removed, 'STAFF should hold audit.view to begin with');

    await app.prisma.role.update({
      where: { id: role.id },
      data: { permissions: { disconnect: { id: removed.id } } },
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/roles',
        headers: admin(),
      });
      const staff = response
        .json<{ data: { name: string; missing: string[] }[] }>()
        .data.find((entry) => entry.name === 'STAFF');
      assert.ok(staff?.missing.includes(Permission.AUDIT_VIEW), JSON.stringify(staff?.missing));
    } finally {
      await app.prisma.role.update({
        where: { id: role.id },
        data: { permissions: { connect: { id: removed.id } } },
      });
    }
  });

  it('is closed to an account without users.manage', async () => {
    for (const url of ['/api/v1/admin/roles', '/api/v1/admin/roles/permissions']) {
      const response = await app.inject({ method: 'GET', url, headers: asCustomer() });
      assert.equal(response.statusCode, 403, `${url} → ${response.body}`);
    }
  });

  /* ------------------------------------------------------------------ jobs -- */

  it('reports every queue the panel runs work through', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/jobs',
      headers: admin(),
    });
    assert.equal(response.statusCode, 200, response.body);

    const rows = response.json<{ data: { key: string; label: string; reachable: boolean }[] }>()
      .data;
    const keys = rows.map((row) => row.key).sort();
    assert.deepEqual(keys, ['backups', 'install', 'mail', 'maintenance', 'schedules', 'webhooks']);
    assert.ok(
      rows.every((row) => row.label.length > 0),
      'a queue named only by its key tells an operator nothing',
    );
  });

  it('refuses a queue name it does not know, rather than reaching for it', async () => {
    // The name becomes a Redis key prefix. Passing it through would make this
    // endpoint a way to read and delete from the same Redis that holds the
    // panel's sessions and rate limits.
    for (const bad of ['bull', '*', 'storm-installs', '../sessions', 'install ']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/jobs/${encodeURIComponent(bad)}/failed`,
        headers: admin(),
      });
      assert.equal(response.statusCode, 400, `${bad} → ${response.statusCode} ${response.body}`);
    }
  });

  it('says so when a job is already gone, rather than pretending', async () => {
    for (const [method, suffix] of [
      ['POST', '/retry'],
      ['DELETE', ''],
    ] as const) {
      const response = await app.inject({
        method,
        url: `/api/v1/admin/jobs/mail/does-not-exist${suffix}`,
        headers: admin(),
      });
      assert.equal(response.statusCode, 404, `${method} → ${response.body}`);
    }
  });

  it('is closed to an account without admin.dashboard', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/jobs',
      headers: asCustomer(),
    });
    assert.equal(response.statusCode, 403, response.body);
  });

  /* ------------------------------------------------- per-account overrides -- */

  it('grants a permission the role does not carry', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${customer.id}`,
      headers: admin(),
      payload: { extraPermissions: [Permission.AUDIT_VIEW] },
    });
    assert.equal(patch.statusCode, 200, patch.body);

    const detail = patch.json<{ data: { permissions: string[]; extraPermissions: string[] } }>()
      .data;
    assert.ok(detail.permissions.includes(Permission.AUDIT_VIEW));
    assert.deepEqual(detail.extraPermissions, [Permission.AUDIT_VIEW]);

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${customer.id}`,
      headers: admin(),
      payload: { extraPermissions: [] },
    });
  });

  it('takes a permission away that the role does carry, and the API obeys it', async () => {
    // The whole point of the deny list, and the reason it being unsettable was
    // a real hole: a customer holds servers.create through their role, and
    // there was no way to stop one account creating servers short of moving
    // them to a role that changes twenty other things.
    // Creating a server is gated on servers.create in a preHandler, so the
    // permission check runs before the body is ever looked at: an empty
    // payload gets a validation error while allowed, and 403 while denied.
    const create = (token: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });

    const before = await create(customer.accessToken);
    assert.notEqual(before.statusCode, 403, 'the customer should start with servers.create');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${customer.id}`,
      headers: admin(),
      payload: { deniedPermissions: [Permission.SERVERS_CREATE] },
    });
    assert.equal(patch.statusCode, 200, patch.body);
    const detail = patch.json<{ data: { permissions: string[]; deniedPermissions: string[] } }>()
      .data;
    assert.deepEqual(detail.deniedPermissions, [Permission.SERVERS_CREATE]);
    assert.ok(
      !detail.permissions.includes(Permission.SERVERS_CREATE),
      'still in the effective set',
    );

    // Enforced, not merely stored. A fresh token, because the old one carries
    // the permissions it was minted with.
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: customer.email, password: customer.password },
    });
    const token = login.json<{ data: { accessToken: string } }>().data.accessToken;

    const after = await create(token);
    assert.equal(after.statusCode, 403, `denied but still allowed: ${after.body}`);

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${customer.id}`,
      headers: admin(),
      payload: { deniedPermissions: [] },
    });
  });

  it('refuses an override naming a permission that does not exist', async () => {
    for (const payload of [
      { extraPermissions: ['servers.teleport'] },
      { deniedPermissions: ['Servers.View'] },
      { deniedPermissions: [''] },
    ]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/users/${customer.id}`,
        headers: admin(),
        payload,
      });
      assert.equal(response.statusCode, 400, `${JSON.stringify(payload)} → ${response.body}`);
    }
  });
});
