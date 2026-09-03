import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_SETTINGS, type PanelSettings } from '@storm/database';
import { hashPassword } from '@storm/security';
import { createTestApp, deleteUser, uniqueSuffix } from './helpers.js';

const execFileAsync = promisify(execFile);
const CLI = path.resolve(fileURLToPath(import.meta.url), '../../src/cli/index.ts');

/**
 * The limits Admin → Settings → Defaults promises a new account.
 *
 * There are three ways an account comes into existence — somebody signs up, an
 * administrator creates one, an operator runs the CLI — and only the first one
 * read the page. The other two fell through to the column defaults, which say
 * `memoryLimit 0` and `diskLimit 0`, and zero means no ceiling anywhere in the
 * panel. So the accounts an operator created by hand were the ones with no
 * quota at all: the opposite of the page they had just filled in.
 *
 * The settings are panel-wide and `node --test` runs the files in parallel, so
 * the two API paths are driven against a process-local override rather than a
 * real write. The CLI is a separate program and cannot see that, so it is
 * checked against the seeded defaults — which still tells the two apart,
 * because what it used to give was nothing at all.
 */
describe('the limits a new account starts with', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let realRead: () => Promise<PanelSettings>;
  let adminToken: string;
  const createdUsers: string[] = [];

  /** Distinct from every default, so a hardcoded number cannot pass for one. */
  const CONFIGURED = {
    defaultServerLimit: 7,
    defaultCpuLimit: 350,
    defaultMemoryLimit: 6144,
    defaultDiskLimit: 30720,
    defaultBackupLimit: 9,
    defaultDatabaseLimit: 4,
    defaultAllocationLimit: 6,
  };

  function configure(overrides: Partial<PanelSettings> | null): void {
    if (overrides === null) {
      app.settings.read = realRead;
      return;
    }
    app.settings.read = async () => ({ ...(await realRead()), ...overrides });
  }

  async function register(): Promise<{ id: string; username: string }> {
    const suffix = uniqueSuffix();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: `defaults-${suffix}@storm.test`,
        username: `defaults${suffix}`,
        password: 'TestPassword123!',
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const id = response.json<{ data: { user: { id: string } } }>().data.user.id;
    createdUsers.push(id);
    return { id, username: `defaults${suffix}` };
  }

  async function createAsAdmin(
    payload: Record<string, unknown> = {},
  ): Promise<{ id: string; limits: Record<string, number> }> {
    const suffix = uniqueSuffix();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        email: `made-${suffix}@storm.test`,
        username: `made${suffix}`,
        password: 'TestPassword123!',
        role: 'CUSTOMER',
        ...payload,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    // The endpoint answers with the account alongside the generated password,
    // not with the account alone.
    const id = response.json<{ data: { user: { id: string } } }>().data.user.id;
    createdUsers.push(id);
    return { id, limits: await limitsOf(id) };
  }

  async function limitsOf(userId: string): Promise<Record<string, number>> {
    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        serverLimit: true,
        cpuLimit: true,
        memoryLimit: true,
        diskLimit: true,
        backupLimit: true,
        databaseLimit: true,
        allocationLimit: true,
      },
    });
    return user;
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;
    realRead = app.settings.read;

    const suffix = uniqueSuffix();
    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const owner = await app.prisma.user.create({
      data: {
        email: `def-owner-${suffix}@storm.test`,
        username: `defowner${suffix}`,
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
    configure(null);
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  it('gives an account that signed up what the page says', async () => {
    configure(CONFIGURED);
    try {
      const user = await register();
      assert.deepEqual(await limitsOf(user.id), {
        serverLimit: 7,
        cpuLimit: 350,
        memoryLimit: 6144,
        diskLimit: 30720,
        backupLimit: 9,
        databaseLimit: 4,
        allocationLimit: 6,
      });
    } finally {
      configure(null);
    }
  });

  it('gives an account an administrator created the same thing', async () => {
    // This is the one that was wrong. An operator sets a 6 GiB default, makes
    // a customer in the panel, and hands over an account with no memory
    // ceiling and no disk ceiling at all.
    configure(CONFIGURED);
    try {
      const { limits } = await createAsAdmin();
      assert.deepEqual(limits, {
        serverLimit: 7,
        cpuLimit: 350,
        memoryLimit: 6144,
        diskLimit: 30720,
        backupLimit: 9,
        databaseLimit: 4,
        allocationLimit: 6,
      });
    } finally {
      configure(null);
    }
  });

  it('still lets the administrator say something else, field by field', async () => {
    configure(CONFIGURED);
    try {
      const { limits } = await createAsAdmin({ limits: { memoryLimit: 512, serverLimit: 1 } });
      assert.equal(limits.memoryLimit, 512, 'the explicit number lost to the default');
      assert.equal(limits.serverLimit, 1);
      // Everything not named still follows the page.
      assert.equal(limits.diskLimit, 30720);
      assert.equal(limits.backupLimit, 9);
    } finally {
      configure(null);
    }
  });

  it('does not sell a quota to the people running the panel', async () => {
    // Staff hit a limit as a bug, never as a policy: an administrator who can
    // create servers for anyone should not be stopped at seven of them.
    configure(CONFIGURED);
    try {
      const { limits } = await createAsAdmin({ role: 'ADMIN' });
      assert.deepEqual(limits, {
        serverLimit: 0,
        cpuLimit: 0,
        memoryLimit: 0,
        diskLimit: 0,
        backupLimit: 0,
        databaseLimit: 0,
        allocationLimit: 0,
      });
    } finally {
      configure(null);
    }
  });

  it('gives an account the CLI created the panel numbers, not its own', async () => {
    // The CLI is a separate program against the same database, so it cannot
    // see the override above — it is checked against the seeded defaults. That
    // still separates the two: it used to set four limits from constants of
    // its own and leave memory, disk and CPU at the column default of zero,
    // which is no ceiling.
    const suffix = uniqueSuffix();
    const username = `clidef${suffix}`;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        CLI,
        'admin',
        'create',
        '--email',
        `clidef-${suffix}@storm.test`,
        '--username',
        username,
        '--password',
        'TestPassword123!',
        '--role',
        'CUSTOMER',
      ],
      { env: process.env },
    ).catch((error: { stdout?: string; stderr?: string }) => ({
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }));

    const created = await app.prisma.user.findUnique({ where: { username } });
    assert.ok(created, `the CLI did not create the account: ${stdout}${stderr}`);
    createdUsers.push(created.id);

    assert.deepEqual(await limitsOf(created.id), {
      serverLimit: DEFAULT_SETTINGS.defaultServerLimit,
      cpuLimit: DEFAULT_SETTINGS.defaultCpuLimit,
      memoryLimit: DEFAULT_SETTINGS.defaultMemoryLimit,
      diskLimit: DEFAULT_SETTINGS.defaultDiskLimit,
      backupLimit: DEFAULT_SETTINGS.defaultBackupLimit,
      databaseLimit: DEFAULT_SETTINGS.defaultDatabaseLimit,
      allocationLimit: DEFAULT_SETTINGS.defaultAllocationLimit,
    });
    assert.notEqual(DEFAULT_SETTINGS.defaultMemoryLimit, 0, 'the seed stopped setting a ceiling');
  });

  it('leaves an account already sold where it was when it is edited', async () => {
    // The defaults describe what a new account starts with, not a policy that
    // follows everyone. Editing somebody's email must not quietly re-provision
    // them to whatever the page says today — least of all a customer who is
    // paying for something smaller than the current default.
    const user = await createAsAdmin({ limits: { memoryLimit: 1024, serverLimit: 1 } });

    configure({ ...CONFIGURED, defaultMemoryLimit: 65536 });
    try {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/users/${user.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { firstName: 'Renamed' },
      });
      assert.equal(response.statusCode, 200, response.body);

      const after = await limitsOf(user.id);
      assert.equal(after.memoryLimit, 1024, 'a rename re-provisioned the account');
      assert.equal(after.serverLimit, 1);
    } finally {
      configure(null);
    }
  });
});
