import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { NotificationType } from '@storm/types';
import { createTestApp, deleteUser, registerUser } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * The account's own doors: which sessions are open, and what the bell holds.
 *
 * Both are per-account lists addressed by id, which is the shape that goes
 * wrong quietly — a route that forgets whose row it is looking at answers
 * cheerfully and hands over, or destroys, somebody else's.
 */
describe('sessions and notifications', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let alice: RegisteredUser;
  let bob: RegisteredUser;
  const createdUsers: string[] = [];

  const as = (user: RegisteredUser) => ({ authorization: `Bearer ${user.accessToken}` });

  /** Signs in again, so the account has a second session to look at. */
  async function secondSession(user: RegisteredUser): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: user.email, password: user.password },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{ data: { accessToken: string } }>().data.accessToken;
  }

  const listSessions = (user: RegisteredUser) =>
    app.inject({ method: 'GET', url: '/api/v1/account/sessions', headers: as(user) });

  const notify = (user: RegisteredUser, title: string) =>
    app.notifications.push(user.id, {
      type: NotificationType.GENERIC,
      title,
      message: 'Something happened.',
      level: 'INFO',
    });

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;
    alice = await registerUser(app);
    bob = await registerUser(app);
    createdUsers.push(alice.id, bob.id);
  });

  after(async () => {
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  beforeEach(async () => {
    await app.prisma.notification.deleteMany({
      where: { userId: { in: [alice.id, bob.id] } },
    });
  });

  /* ------------------------------------------------------- sessions -- */

  it('lists this account’s sessions and marks the one being used', async () => {
    await secondSession(alice);

    const response = await listSessions(alice);
    assert.equal(response.statusCode, 200, response.body);

    const rows = response.json<{ data: { id: string; current: boolean }[] }>().data;
    assert.ok(rows.length >= 2, `expected at least two sessions, got ${rows.length}`);
    assert.equal(
      rows.filter((row) => row.current).length,
      1,
      'exactly one session is the one making the request',
    );
  });

  it('shows one account nothing of another’s sessions', async () => {
    await secondSession(bob);

    const rows = (await listSessions(alice)).json<{ data: { id: string }[] }>().data;
    const bobSessions = await app.prisma.session.findMany({ where: { userId: bob.id } });
    const leaked = rows.filter((row) => bobSessions.some((session) => session.id === row.id));

    assert.deepEqual(leaked, []);
  });

  it('will not revoke a session belonging to somebody else', async () => {
    // Guessing an id must not be enough. 404 rather than 403, so the id is not
    // confirmed to exist either.
    await secondSession(bob);
    const target = await app.prisma.session.findFirstOrThrow({
      where: { userId: bob.id, revokedAt: null },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/account/sessions/${target.id}`,
      headers: as(alice),
    });

    assert.equal(response.statusCode, 404, response.body);
    const after = await app.prisma.session.findUniqueOrThrow({ where: { id: target.id } });
    assert.equal(after.revokedAt, null, 'another account’s session was revoked');
  });

  it('revokes one of its own, and the token that came with it stops working', async () => {
    const token = await secondSession(alice);
    const mine = await app.prisma.session.findFirstOrThrow({
      where: { userId: alice.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/account/sessions/${mine.id}`,
      headers: as(alice),
    });
    assert.equal(revoked.statusCode, 200, revoked.body);

    // The access token is short-lived and signed, so the only thing that can
    // retire it early is the session row being checked on every request.
    const afterwards = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(afterwards.statusCode, 401, afterwards.body);
  });

  it('signs out everywhere else without signing out here', async () => {
    await secondSession(alice);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account/sessions',
      headers: as(alice),
    });
    assert.equal(response.statusCode, 200, response.body);

    // The session making the request survives, or "sign out everywhere else"
    // would be "sign out", and the person would be looking at a login page
    // wondering what they pressed.
    const still = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: as(alice),
    });
    assert.equal(still.statusCode, 200, still.body);

    const live = await app.prisma.session.count({
      where: { userId: alice.id, revokedAt: null },
    });
    assert.equal(live, 1);
  });

  it('leaves another account’s sessions alone when signing out everywhere', async () => {
    await secondSession(bob);
    const before = await app.prisma.session.count({ where: { userId: bob.id, revokedAt: null } });

    await app.inject({
      method: 'DELETE',
      url: '/api/v1/account/sessions',
      headers: as(alice),
    });

    assert.equal(
      await app.prisma.session.count({ where: { userId: bob.id, revokedAt: null } }),
      before,
    );
  });

  /* -------------------------------------------------- notifications -- */

  it('shows an account only its own notifications, and counts the unread', async () => {
    await notify(alice, 'For Alice');
    await notify(bob, 'For Bob');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/account/notifications',
      headers: as(alice),
    });
    assert.equal(response.statusCode, 200, response.body);

    const data = response.json<{ data: { items: { title: string }[]; unread: number } }>().data;
    assert.deepEqual(
      data.items.map((item) => item.title),
      ['For Alice'],
    );
    assert.equal(data.unread, 1);
  });

  it('will not mark somebody else’s notification as read', async () => {
    await notify(bob, 'For Bob');
    const theirs = await app.prisma.notification.findFirstOrThrow({ where: { userId: bob.id } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/account/notifications/read',
      headers: as(alice),
      payload: { ids: [theirs.id] },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<{ data: { marked: number } }>().data.marked, 0);

    const after = await app.prisma.notification.findUniqueOrThrow({ where: { id: theirs.id } });
    assert.equal(after.readAt, null, 'another account’s notification was marked read');
  });

  it('will not delete somebody else’s notification', async () => {
    await notify(bob, 'For Bob');
    const theirs = await app.prisma.notification.findFirstOrThrow({ where: { userId: bob.id } });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/account/notifications/${theirs.id}`,
      headers: as(alice),
    });
    // Answers cheerfully — it has nothing to say about a row it may not see —
    // but the row is what matters.
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(await app.prisma.notification.findUnique({ where: { id: theirs.id } }));
  });

  it('marks its own as read, all at once', async () => {
    await notify(alice, 'One');
    await notify(alice, 'Two');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/account/notifications/read',
      headers: as(alice),
      payload: {},
    });
    assert.equal(response.json<{ data: { marked: number } }>().data.marked, 2);

    assert.equal(
      await app.prisma.notification.count({ where: { userId: alice.id, readAt: null } }),
      0,
    );
  });
});
