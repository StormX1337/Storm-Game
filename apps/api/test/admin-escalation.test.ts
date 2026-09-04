import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '@storm/security';
import { Permission } from '@storm/types';
import { createTestApp, deleteUser, uniqueSuffix } from './helpers.js';

/**
 * What a staff member may hand to somebody else.
 *
 * Two different bounds, and only one of them was there. `assertOutranks` stops
 * a staff member managing an account at or above their own level, which is
 * about *roles*. Nothing stopped them writing a *permission* onto a lower
 * account that they do not hold themselves — and since the same staff member
 * can set that account's password, granting it is the same as taking it.
 *
 * Every other delegation in the panel already refuses this: a share cannot
 * carry more than the sharer holds, an API key can only narrow its owner. This
 * was the one place it could go the other way.
 */
describe('what a staff member may grant', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let adminToken: string;
  let ownerToken: string;
  let adminId: string;
  let targetId: string;
  const createdUsers: string[] = [];

  const asAdmin = () => ({ authorization: `Bearer ${adminToken}` });
  const asOwner = () => ({ authorization: `Bearer ${ownerToken}` });

  async function makeUser(
    role: string,
    options: { extraPermissions?: string[]; deniedPermissions?: string[] } = {},
  ): Promise<{ id: string; email: string; token: string }> {
    const suffix = uniqueSuffix();
    const roleRow = await app.prisma.role.findUniqueOrThrow({ where: { name: role } });
    const email = `esc-${suffix}@storm.test`;
    const user = await app.prisma.user.create({
      data: {
        email,
        username: `esc${suffix}`,
        passwordHash: await hashPassword('EscalationTest123!'),
        roleId: roleRow.id,
        emailVerifiedAt: new Date(),
        extraPermissions: options.extraPermissions ?? [],
        deniedPermissions: options.deniedPermissions ?? [],
      },
    });
    createdUsers.push(user.id);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: email, password: 'EscalationTest123!' },
    });
    assert.equal(login.statusCode, 200, login.body);
    return {
      id: user.id,
      email,
      token: login.json<{ data: { accessToken: string } }>().data.accessToken,
    };
  }

  const permissionsOf = async (id: string): Promise<string[]> =>
    (await app.prisma.user.findUniqueOrThrow({ where: { id } })).extraPermissions;

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    const owner = await makeUser('OWNER');
    ownerToken = owner.token;

    // A staff account: it holds `users.manage`, so it may use these routes at
    // all, and it does not hold `settings.manage`. That is the built-in STAFF
    // grant, not a contrived one — which is what makes this reachable.
    const admin = await makeUser('STAFF');
    adminToken = admin.token;
    adminId = admin.id;
  });

  after(async () => {
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    const target = await makeUser('CUSTOMER');
    targetId = target.id;
  });

  /* ------------------------------------------------------ creating -- */

  it('will not create an account holding a permission the creator lacks', async () => {
    // The escalation: the staff member cannot reach panel settings, so they
    // make an account that can — and they can set its password, so it is
    // theirs.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: asAdmin(),
      payload: {
        email: `puppet-${uniqueSuffix()}@storm.test`,
        username: `puppet${uniqueSuffix()}`,
        role: 'CUSTOMER',
        extraPermissions: [Permission.SETTINGS_MANAGE],
        deniedPermissions: [],
      },
    });

    assert.equal(response.statusCode, 403, response.body);
    assert.match(response.body, /do not hold/i);
  });

  it('still creates an account with permissions the creator does hold', async () => {
    // The control: a staff member delegating what is theirs to delegate is
    // the whole point of the route.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: asAdmin(),
      payload: {
        email: `helper-${uniqueSuffix()}@storm.test`,
        username: `helper${uniqueSuffix()}`,
        role: 'CUSTOMER',
        extraPermissions: [Permission.AUDIT_VIEW],
        deniedPermissions: [],
      },
    });

    assert.equal(response.statusCode, 201, response.body);
    createdUsers.push(response.json<{ data: { user: { id: string } } }>().data.user.id);
  });

  /* ------------------------------------------------------ updating -- */

  it('will not add a permission the editor lacks to an existing account', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${targetId}`,
      headers: asAdmin(),
      payload: { extraPermissions: [Permission.SETTINGS_MANAGE] },
    });

    assert.equal(response.statusCode, 403, response.body);
    assert.deepEqual(await permissionsOf(targetId), []);
  });

  it('refuses the whole list rather than quietly keeping the allowed half', async () => {
    // Silently dropping one would leave the staff member believing they had
    // granted something they had not — the same reason a scoped API key
    // refuses an unknown permission instead of ignoring it.
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${targetId}`,
      headers: asAdmin(),
      payload: {
        extraPermissions: [Permission.AUDIT_VIEW, Permission.SETTINGS_MANAGE],
      },
    });

    assert.equal(response.statusCode, 403, response.body);
    assert.deepEqual(await permissionsOf(targetId), []);
  });

  it('lets the owner grant anything, because they already hold everything', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${targetId}`,
      headers: asOwner(),
      payload: { extraPermissions: [Permission.SETTINGS_MANAGE] },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(await permissionsOf(targetId), [Permission.SETTINGS_MANAGE]);
  });

  it('lets a staff member take a permission away that they cannot grant', async () => {
    // Denying is a reduction and never needs a ceiling: a staff member who
    // cannot reach settings can still stop somebody else reaching them.
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${targetId}`,
      headers: asAdmin(),
      payload: { deniedPermissions: [Permission.SETTINGS_MANAGE] },
    });

    assert.equal(response.statusCode, 200, response.body);
    const after = await app.prisma.user.findUniqueOrThrow({ where: { id: targetId } });
    assert.deepEqual(after.deniedPermissions, [Permission.SETTINGS_MANAGE]);
  });

  /* --------------------------------------------------- role ceiling -- */

  it('still refuses to manage an account at its own level', async () => {
    // The bound that was already there, kept honest.
    const peer = await makeUser('STAFF');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${peer.id}`,
      headers: asAdmin(),
      payload: { firstName: 'Nope' },
    });
    assert.equal(response.statusCode, 403, response.body);
  });

  it('will not promote anybody to its own level or above', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${targetId}`,
      headers: asAdmin(),
      payload: { role: 'STAFF' },
    });
    assert.equal(response.statusCode, 403, response.body);
  });

  /* ------------------------------------------- acting on an account -- */

  it('cuts a suspended account off at once rather than at token expiry', async () => {
    // Suspension that leaves the existing session working is not suspension
    // for the fifteen minutes that matter most.
    const victim = await makeUser('CUSTOMER');

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${victim.id}/suspend`,
      headers: asAdmin(),
    });
    assert.equal(response.statusCode, 200, response.body);

    const afterwards = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${victim.token}` },
    });
    assert.notEqual(afterwards.statusCode, 200, 'a suspended account kept its session');
    assert.equal(
      await app.prisma.session.count({ where: { userId: victim.id, revokedAt: null } }),
      0,
    );
  });

  it('lets them back in when the suspension is lifted', async () => {
    const victim = await makeUser('CUSTOMER');
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${victim.id}/suspend`,
      headers: asAdmin(),
    });

    const lifted = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${victim.id}/unsuspend`,
      headers: asAdmin(),
    });
    assert.equal(lifted.statusCode, 200, lifted.body);

    // Signing in again is the way back — the old session stays revoked.
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: victim.email, password: 'EscalationTest123!' },
    });
    assert.equal(login.statusCode, 200, login.body);
  });

  it('will not suspend an account at or above its own level', async () => {
    const peer = await makeUser('STAFF');

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${peer.id}/suspend`,
      headers: asAdmin(),
    });
    assert.equal(response.statusCode, 403, response.body);
    const after = await app.prisma.user.findUniqueOrThrow({ where: { id: peer.id } });
    assert.equal(after.suspendedAt, null);
  });

  it('hands back a new password once, and the old one stops working', async () => {
    const victim = await makeUser('CUSTOMER');

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${victim.id}/reset-password`,
      headers: asAdmin(),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.json<{ data: { password: string } }>().data.password.length >= 12);

    const old = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: victim.email, password: 'EscalationTest123!' },
    });
    assert.notEqual(old.statusCode, 200, 'the old password still worked');
  });

  it('cannot edit itself through the admin routes', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${adminId}`,
      headers: asAdmin(),
      payload: { firstName: 'Myself' },
    });
    assert.equal(response.statusCode, 403, response.body);
  });
});
