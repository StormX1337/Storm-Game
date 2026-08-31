import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { generateToken, hashToken } from '@storm/security';
import { createTestApp, uniqueSuffix } from './helpers.js';

const execFileAsync = promisify(execFile);
const CLI = path.resolve(fileURLToPath(import.meta.url), '../../src/cli/index.ts');

/**
 * The CLI is a separate program from the API, so it is driven the way an
 * operator drives it — as a subprocess against the same database. What is
 * tested here is the part with security consequences: rotating a node token has
 * to stop the old one working, because the reason to rotate is usually that
 * somebody else has it.
 */
describe('command line', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  const createdNodes: string[] = [];

  async function run(args: string[]): Promise<{ stdout: string; code: number }> {
    try {
      const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', CLI, ...args], {
        env: process.env,
      });
      return { stdout, code: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}`, code: failure.code ?? 1 };
    }
  }

  async function createNode(): Promise<{ id: string; name: string; tokenRowId: string }> {
    const name = `cli-test-${uniqueSuffix()}`;
    const node = await app.prisma.node.create({
      data: {
        name,
        location: 'Test',
        hostname: '127.0.0.1',
        ip: '127.0.0.1',
        publicIp: '127.0.0.1',
        scheme: 'http',
        agentPort: 8081,
        sftpPort: 2022,
        cpuCores: 1,
        memoryTotal: 1024,
        diskTotal: 10240,
      },
    });
    createdNodes.push(node.id);

    const token = await app.prisma.nodeToken.create({
      data: {
        nodeId: node.id,
        name: 'original',
        tokenId: generateToken(8).slice(0, 16),
        tokenHash: hashToken(generateToken(32)),
        secretEnc: app.encrypter.encrypt(generateToken(32)),
      },
    });

    return { id: node.id, name, tokenRowId: token.id };
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;
  });

  after(async () => {
    await app.prisma.nodeToken.deleteMany({ where: { nodeId: { in: createdNodes } } });
    await app.prisma.node.deleteMany({ where: { id: { in: createdNodes } } });
    await cleanup();
  });

  it('rotating a node token revokes the one it replaces', async () => {
    const node = await createNode();

    const result = await run(['node', 'token', node.name]);
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /AGENT_TOKEN_ID/);

    const previous = await app.prisma.nodeToken.findUniqueOrThrow({
      where: { id: node.tokenRowId },
    });
    assert.notEqual(previous.revokedAt, null, 'the replaced token is still valid');

    const active = await app.prisma.nodeToken.findMany({
      where: { nodeId: node.id, revokedAt: null },
    });
    assert.equal(active.length, 1, 'exactly one token should be usable after a rotation');
    assert.notEqual(active[0]?.id, node.tokenRowId);
  });

  it('--keep-existing leaves the previous token usable', async () => {
    const node = await createNode();

    const result = await run(['node', 'token', node.name, '--keep-existing']);
    assert.equal(result.code, 0, result.stdout);

    const previous = await app.prisma.nodeToken.findUniqueOrThrow({
      where: { id: node.tokenRowId },
    });
    assert.equal(previous.revokedAt, null);

    const active = await app.prisma.nodeToken.count({
      where: { nodeId: node.id, revokedAt: null },
    });
    assert.equal(active, 2);
  });

  it('fails, rather than inventing a node, when the name is unknown', async () => {
    const result = await run(['node', 'token', `does-not-exist-${uniqueSuffix()}`]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /No node named/);
  });

  it('doctor reports a healthy stack and exits zero', async () => {
    const result = await run(['doctor']);
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /Database reachable/);
    assert.match(result.stdout, /Redis reachable/);
    assert.match(result.stdout, /Schema is up to date/);
    assert.match(result.stdout, /Secrets are long enough and distinct/);
  });

  it('doctor refuses a configuration that reuses one secret for everything', async () => {
    const shared = 'a-single-value-standing-in-for-three-secrets';
    const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', CLI, 'doctor'], {
      env: { ...process.env, JWT_SECRET: shared, ENCRYPTION_KEY: shared, COOKIE_SECRET: shared },
    }).catch((error: { stdout?: string; stderr?: string }) => ({
      stdout: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    }));

    assert.match(stdout, /must differ from each other/);
  });

  it('id prints one readable identifier and nothing else', async () => {
    const result = await run(['id']);
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout.trim(), /^[A-Za-z0-9]{6,12}$/);
  });
});
