import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ALL_PERMISSIONS, Permission } from '@storm/types';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Keys that can do less than the person who made them.
 *
 * The auth layer has narrowed a key to its permission list since the
 * beginning, and the panel only ever asked for a name — so every key it could
 * produce carried its owner's whole authority and never expired. The
 * deployment script, the Discord bot and the uptime check all held the key you
 * sign in with.
 *
 * These pin down the contract the panel now depends on: what a scoped key can
 * and cannot reach, that an expired one is dead, that the catalogue offered
 * for picking is the caller's own, and that a typo is refused rather than
 * quietly dropped — which would leave a key narrower than the person who made
 * it believed.
 */
describe('personal API keys', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let customer: RegisteredUser;
  const createdUsers: string[] = [];

  const asUser = () => ({ authorization: `Bearer ${customer.accessToken}` });
  const withKey = (token: string) => ({ authorization: `Bearer ${token}` });

  async function makeKey(payload: Record<string, unknown>): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/account/api-keys',
      headers: asUser(),
      payload: { name: `key-${uniqueSuffix().slice(0, 6)}`, ...payload },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{ data: { token: string } }>().data.token;
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;
    customer = await registerUser(app);
    createdUsers.push(customer.id);
  });

  after(async () => {
    await app.prisma.apiKey.deleteMany({ where: { userId: customer.id } });
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  /* ------------------------------------------------------------- scope -- */

  it('offers the caller their own permissions, not the whole catalogue', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/account/permissions',
      headers: asUser(),
    });
    assert.equal(response.statusCode, 200, response.body);

    const rows = response.json<{ data: { key: string; description: string }[] }>().data;
    const keys = rows.map((row) => row.key);

    assert.ok(keys.includes(Permission.SERVERS_VIEW), 'a customer can view servers');
    // Offering an administration permission would be offering something that
    // is silently dropped the moment the key is made.
    assert.ok(!keys.includes(Permission.ADMIN_USERS), 'offered a permission this account lacks');
    assert.ok(keys.length < ALL_PERMISSIONS.length, 'handed over the whole catalogue');
    assert.ok(
      rows.every((row) => row.description.length > 0),
      'a permission named only by its key tells nobody anything',
    );
  });

  // Creating a server is gated on servers.create in a preHandler, so the
  // permission is decided before the body is looked at: a key that holds it
  // gets a validation error for the empty payload, and one that does not gets
  // 403. That difference is the whole contract, on one endpoint.
  const tryCreate = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/api/v1/servers', headers, payload: {} });

  it('lets a scoped key through to what it names', async () => {
    const token = await makeKey({ permissions: [Permission.SERVERS_CREATE] });
    const response = await tryCreate(withKey(token));
    assert.notEqual(response.statusCode, 403, response.body);
  });

  it('stops a scoped key at everything it does not name', async () => {
    // The point of the whole feature: the key on the deployment box can read
    // the server list and cannot create anything.
    const token = await makeKey({ permissions: [Permission.SERVERS_VIEW] });
    const withScope = await tryCreate(withKey(token));
    assert.equal(withScope.statusCode, 403, withScope.body);

    // And the same account, signed in normally, still can.
    const asOwner = await tryCreate(asUser());
    assert.notEqual(asOwner.statusCode, 403, 'the account itself lost the permission');
  });

  it('never lets a key reach past the person who made it', async () => {
    // Asking for something the account does not hold is refused outright
    // rather than granted — a key is a narrowing, never a promotion.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/account/api-keys',
      headers: asUser(),
      payload: { name: 'too much', permissions: [Permission.ADMIN_USERS] },
    });
    assert.equal(response.statusCode, 403, response.body);
  });

  it('refuses a permission that does not exist, rather than dropping it', async () => {
    // Silently ignoring a typo leaves a key narrower than whoever made it
    // believes, and they find out when the nightly job stops working.
    for (const permissions of [['servers.teleport'], ['Servers.View'], ['']]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/account/api-keys',
        headers: asUser(),
        payload: { name: 'typo', permissions },
      });
      assert.equal(response.statusCode, 400, `${JSON.stringify(permissions)} → ${response.body}`);
    }
  });

  it('treats an empty list as the full-access key it is', async () => {
    // The panel makes this a deliberate choice rather than the shape of an
    // untouched form, and the listing labels it, because a key with no boxes
    // ticked is the most powerful one there is.
    const token = await makeKey({ permissions: [] });
    const response = await tryCreate(withKey(token));
    assert.notEqual(
      response.statusCode,
      403,
      `an empty list narrowed to nothing: ${response.body}`,
    );

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/account/api-keys',
      headers: asUser(),
    });
    const rows = listed.json<{ data: { permissions: string[] }[] }>().data;
    assert.ok(
      rows.some((row) => row.permissions.length === 0),
      'the panel cannot tell a full-access key from a scoped one',
    );
  });

  /* ------------------------------------------------------------ expiry -- */

  it('records the expiry it was asked for, and says so', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/account/api-keys',
      headers: asUser(),
      payload: { name: 'ninety days', expiresInDays: 90 },
    });
    assert.equal(response.statusCode, 200, response.body);

    const issued = response.json<{ data: { expiresAt: string | null; keyId: string } }>().data;
    assert.ok(issued.expiresAt, 'the panel has nothing to show the operator');
    const days = (new Date(issued.expiresAt).getTime() - Date.now()) / 86400_000;
    assert.ok(days > 89 && days < 91, `${days} days is not ninety`);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/account/api-keys',
      headers: asUser(),
    });
    const row = listed
      .json<{ data: { keyId: string; expiresAt: string | null }[] }>()
      .data.find((entry) => entry.keyId === issued.keyId);
    assert.equal(row?.expiresAt, issued.expiresAt);
  });

  it('stops an expired key working, without needing anyone to revoke it', async () => {
    // Which is the reason to set one: the key on the laptop of somebody who
    // left goes quiet on its own.
    const token = await makeKey({ expiresInDays: 30 });
    const keyId = token.slice('storm_'.length).split('.')[0];

    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/account',
      headers: withKey(token),
    });
    assert.equal(before.statusCode, 200, before.body);

    await app.prisma.apiKey.update({
      where: { keyId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/account',
      headers: withKey(token),
    });
    assert.equal(after.statusCode, 401, after.body);
  });

  it('refuses an expiry the panel would not survive offering', async () => {
    for (const expiresInDays of [0, -1, 4000, 1.5]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/account/api-keys',
        headers: asUser(),
        payload: { name: 'bad expiry', expiresInDays },
      });
      assert.equal(response.statusCode, 400, `${expiresInDays} → ${response.body}`);
    }
  });
});
