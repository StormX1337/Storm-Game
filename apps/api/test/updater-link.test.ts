import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from './helpers.js';

/**
 * Whether the panel offers the update button. Compose mounts the control
 * directory on every deployment, so its existence says nothing — the question
 * is whether a host-side updater is alive to read what gets written there. A
 * button that writes a request nothing reads is worse than no button: it looks
 * like it worked.
 */
describe('detecting the host-side updater', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let dir: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storm-control-'));
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;
    app.env.UPDATE_CONTROL_DIR = dir;
    // A build with no commit stamp cannot be compared against anything, and
    // status() says so instead of reporting on the updater. That is the right
    // order for a real deployment, and it would hide what is under test here.
    app.env.STORM_COMMIT = '1'.repeat(40);
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await cleanup();
  });

  async function beat(secondsAgo: number): Promise<void> {
    await fs.writeFile(
      path.join(dir, 'updater.json'),
      JSON.stringify({ seenAt: new Date(Date.now() - secondsAgo * 1000).toISOString() }),
    );
  }

  it('offers nothing when the directory is mounted but empty', async () => {
    const status = await app.updates.status();
    assert.equal(status.canApply, false);
    assert.match(status.reason ?? '', /No updater is connected/);
  });

  it('offers the update once the updater is checking in', async () => {
    await beat(5);
    const status = await app.updates.status();
    // canApply also depends on there being an update to apply, so what is
    // asserted here is the absence of the updater complaint.
    assert.doesNotMatch(status.reason ?? '', /No updater is connected/);
    assert.doesNotMatch(status.reason ?? '', /last checked in/);
  });

  it('stops offering it when the updater goes quiet', async () => {
    await beat(600);
    const status = await app.updates.status();
    assert.equal(status.canApply, false);
    assert.match(status.reason ?? '', /last checked in 10 minute/);
    assert.match(status.reason ?? '', /systemctl status storm-updater/);
  });

  it('treats an unparseable heartbeat as no updater at all', async () => {
    await fs.writeFile(path.join(dir, 'updater.json'), 'not json');
    const status = await app.updates.status();
    assert.equal(status.canApply, false);
    assert.match(status.reason ?? '', /No updater is connected/);
  });

  it('accepts the heartbeat the updater script actually writes', async () => {
    // Guards against the two sides drifting: the shape asserted above is the
    // shape scripts/storm-updater.sh produces, not one invented for the test.
    await fs.writeFile(
      path.join(dir, 'updater.json'),
      `{
  "seenAt": "${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}",
  "interval": 15,
  "repository": "/opt/storm-panel",
  "pid": 1234
}
`,
    );
    const status = await app.updates.status();
    assert.doesNotMatch(status.reason ?? '', /No updater is connected/);
  });
});
