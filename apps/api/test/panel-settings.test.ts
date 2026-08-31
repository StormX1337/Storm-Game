import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '@storm/security';
import { DEFAULT_SETTINGS, writeSettings, type PanelSettings } from '@storm/database';
import { authHeaders, createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Panel settings, and the two things that make them worth having: a browser
 * that has not signed in yet can read the public ones, and maintenance mode
 * actually turns customers away.
 *
 * The settings table is panel-wide, so this suite puts every value it touched
 * back afterwards — a leftover `maintenanceMode: true` would break every other
 * suite, and a developer's own panel with it.
 */
describe('panel settings', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let customer: RegisteredUser;
  let ownerToken: string;
  let realRead: () => Promise<PanelSettings>;
  const createdUsers: string[] = [];

  const PRIVATE_KEYS = [
    'defaultServerLimit',
    'defaultMemoryLimit',
    'defaultDiskLimit',
    'defaultBackupLimit',
    'defaultDatabaseLimit',
    'defaultAllocationLimit',
    'backupRetentionDays',
  ];

  /**
   * Turns maintenance on for this app instance only.
   *
   * Not by writing the setting: `node --test` runs the test files as parallel
   * processes against one database, so a real `maintenanceMode: true` would
   * make every other suite start getting 503s — and would leave the developer's
   * own panel in maintenance if this run were killed halfway. Overriding the
   * cache the routes read from is process-local and exercises the same code.
   */
  function setMaintenance(message: string | null): void {
    if (message === null) {
      app.settings.read = realRead;
      return;
    }
    app.settings.read = async () => ({
      ...(await realRead()),
      maintenanceMode: true,
      maintenanceMessage: message,
    });
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;
    realRead = app.settings.read;

    customer = await registerUser(app);
    createdUsers.push(customer.id);

    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const suffix = uniqueSuffix();
    const owner = await app.prisma.user.create({
      data: {
        email: `settings-owner-${suffix}@storm.test`,
        username: `settingsowner${suffix}`,
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
    ownerToken = login.json<{ data: { accessToken: string } }>().data.accessToken;
  });

  after(async () => {
    setMaintenance(null);
    await writeSettings(app.prisma, {
      brandColor: DEFAULT_SETTINGS.brandColor,
      announcement: DEFAULT_SETTINGS.announcement,
      announcementLevel: DEFAULT_SETTINGS.announcementLevel,
    });
    app.settings.invalidate();
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  /* ------------------------------------------------- the public endpoint -- */

  it('serves branding and sign-in policy without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/settings' });

    assert.equal(response.statusCode, 200);
    const settings = response.json<{ data: Record<string, unknown> }>().data;
    assert.equal(typeof settings.panelName, 'string');
    assert.equal(typeof settings.brandColor, 'string');
    assert.equal(typeof settings.registrationEnabled, 'boolean');
    assert.equal(typeof settings.maintenanceMode, 'boolean');
  });

  it('never leaks how the panel is run to an anonymous caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    const settings = response.json<{ data: Record<string, unknown> }>().data;

    for (const key of PRIVATE_KEYS) {
      assert.equal(
        key in settings,
        false,
        `${key} describes how the panel is run and must stay behind the admin API`,
      );
    }
  });

  it('reflects a rebrand on the very next request', async () => {
    const name = `Panel ${uniqueSuffix()}`;
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/settings',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { panelName: name, brandColor: '#ff8800' },
    });
    assert.equal(patch.statusCode, 200);

    // No sleep: writing settings has to drop the cache, or an administrator
    // saves a change and watches nothing happen for as long as the TTL lasts.
    const response = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    const settings = response.json<{ data: Record<string, unknown> }>().data;
    assert.equal(settings.panelName, name);
    assert.equal(settings.brandColor, '#ff8800');

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/settings',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { panelName: DEFAULT_SETTINGS.panelName, brandColor: DEFAULT_SETTINGS.brandColor },
    });
  });

  /* ------------------------------------------------------- brand colour -- */

  it('refuses anything but a six-digit hex as the brand colour', async () => {
    // The value is written into a CSS custom property in every visitor's
    // browser, so each of these would be a stylesheet injected panel-wide.
    const rejected = [
      'red; } :root { display: none',
      'url(https://example.invalid/x.png)',
      'javascript:alert(1)',
      '#2563eb; color: red',
      '#gggggg',
      '#2563e',
      'rgb(37, 99, 235)',
    ];

    for (const brandColor of rejected) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/admin/settings',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { brandColor },
      });
      assert.equal(response.statusCode, 400, `${brandColor} must be rejected`);
    }

    const accepted = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/settings',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { brandColor: '#A1B2C3' },
    });
    assert.equal(accepted.statusCode, 200);
  });

  it('caps an announcement and only accepts the levels the banner can draw', async () => {
    const tooLong = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/settings',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { announcement: 'x'.repeat(501) },
    });
    assert.equal(tooLong.statusCode, 400);

    const badLevel = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/settings',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { announcementLevel: 'urgent' },
    });
    assert.equal(badLevel.statusCode, 400);
  });

  /* ---------------------------------------------------- maintenance mode -- */

  describe('while maintenance mode is on', () => {
    const message = 'Back in twenty minutes.';

    before(() => {
      setMaintenance(message);
    });

    after(() => {
      setMaintenance(null);
    });

    it('turns a customer away with the reason, not a bare failure', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/servers',
        headers: authHeaders(customer),
      });

      assert.equal(response.statusCode, 503);
      const body = response.json<{ error: { code: string; message: string } }>();
      assert.equal(body.error.code, 'MAINTENANCE_MODE');
      assert.equal(
        body.error.message,
        message,
        'the customer should read the message the administrator wrote',
      );
    });

    it('lets an administrator keep working, or nobody can switch it back off', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/settings',
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(response.statusCode, 200);
    });

    it('keeps sign-in open so an administrator can get to the switch', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: customer.email, password: customer.password },
      });
      assert.equal(response.statusCode, 200);
    });

    it('keeps the session endpoints answering, so the panel can explain itself', async () => {
      // With `/auth/me` blocked the browser cannot tell "signed out" from
      // "maintenance", and bounces the customer to the login page instead of
      // showing them the notice.
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: authHeaders(customer),
      });
      assert.equal(me.statusCode, 200);

      const settings = await app.inject({ method: 'GET', url: '/api/v1/settings' });
      assert.equal(settings.statusCode, 200);
      assert.equal(
        settings.json<{ data: { maintenanceMode: boolean } }>().data.maintenanceMode,
        true,
      );
    });

    it('keeps the health probes answering, so nothing drains the API', async () => {
      const health = await app.inject({ method: 'GET', url: '/health' });
      assert.equal(health.statusCode, 200);

      const ready = await app.inject({ method: 'GET', url: '/ready' });
      assert.notEqual(ready.statusCode, 503, 'readiness must not fail because of maintenance');
    });

    it('refuses new sign-ups', async () => {
      const suffix = uniqueSuffix();
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: `maint-${suffix}@storm.test`,
          username: `maint${suffix}`,
          password: 'TestPassword123!',
        },
      });

      assert.equal(response.statusCode, 503);
      assert.equal(
        response.json<{ error: { code: string } }>().error.code,
        'MAINTENANCE_MODE',
        'an account created now could not use the panel anyway',
      );
    });

    it('keeps node callbacks flowing, so state is not lost while it is on', async () => {
      // Not authorised — a real node sends its token — but it must fail on the
      // credentials rather than on maintenance, or the panel comes back with a
      // wrong picture of which servers are running.
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/heartbeat',
        payload: {},
      });
      assert.notEqual(
        response.statusCode,
        503,
        'the node API must not be turned off by maintenance mode',
      );
    });
  });
});
