import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyConfigFiles } from '../src/services/config-files.service.js';

const log = { warn: () => undefined };

async function scratch(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'storm-config-'));
}

test('config files', async (t) => {
  await t.test('rewrites a properties key without disturbing the rest', async () => {
    const root = await scratch();
    await fs.writeFile(
      path.join(root, 'server.properties'),
      '#Minecraft server properties\nmotd=A server\nserver-port=25565\nmax-players=20\n',
    );

    await applyConfigFiles(
      root,
      [{ path: 'server.properties', parser: 'properties', find: { 'server-port': '30012' } }],
      log,
    );

    const result = await fs.readFile(path.join(root, 'server.properties'), 'utf8');
    assert.match(result, /^server-port=30012$/m);
    assert.match(result, /^motd=A server$/m);
    assert.match(result, /^max-players=20$/m);
    assert.match(result, /^#Minecraft server properties$/m);
  });

  await t.test('appends a properties key the file does not have', async () => {
    const root = await scratch();
    await fs.writeFile(path.join(root, 'server.properties'), 'motd=A server\n');

    await applyConfigFiles(
      root,
      [{ path: 'server.properties', parser: 'properties', find: { 'query.port': '30012' } }],
      log,
    );

    const result = await fs.readFile(path.join(root, 'server.properties'), 'utf8');
    assert.match(result, /^query\.port=30012$/m);
    assert.match(result, /^motd=A server$/m);
  });

  await t.test('creates the file when the game has not written one yet', async () => {
    const root = await scratch();

    await applyConfigFiles(
      root,
      [{ path: 'config/server.properties', parser: 'properties', find: { 'server-port': '1234' } }],
      log,
    );

    const result = await fs.readFile(path.join(root, 'config/server.properties'), 'utf8');
    assert.match(result, /^server-port=1234$/m);
  });

  await t.test('writes JSON with real types, not strings', async () => {
    const root = await scratch();
    await fs.writeFile(path.join(root, 'config.json'), '{"net":{"port":1},"name":"keep me"}');

    await applyConfigFiles(
      root,
      [
        {
          path: 'config.json',
          parser: 'json',
          find: { 'net.port': '30012', 'net.public': 'true', 'net.host': '0.0.0.0' },
        },
      ],
      log,
    );

    const result = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')) as {
      net: { port: number; public: boolean; host: string };
      name: string;
    };
    assert.equal(result.net.port, 30012);
    assert.equal(result.net.public, true);
    assert.equal(result.net.host, '0.0.0.0');
    assert.equal(result.name, 'keep me');
  });

  await t.test('writes YAML, preserving untouched keys', async () => {
    const root = await scratch();
    await fs.writeFile(path.join(root, 'config.yml'), 'settings:\n  port: 1\n  motd: hello\n');

    await applyConfigFiles(
      root,
      [{ path: 'config.yml', parser: 'yaml', find: { 'settings.port': '30012' } }],
      log,
    );

    const result = await fs.readFile(path.join(root, 'config.yml'), 'utf8');
    assert.match(result, /port: 30012/);
    assert.match(result, /motd: hello/);
  });

  await t.test('keeps INI keys inside their own section', async () => {
    const root = await scratch();
    await fs.writeFile(path.join(root, 'game.ini'), '[Network]\nPort=1\n\n[Game]\nName=x\n');

    await applyConfigFiles(
      root,
      [
        {
          path: 'game.ini',
          parser: 'ini',
          find: { 'Network.Port': '30012', 'Network.QueryPort': '30013' },
        },
      ],
      log,
    );

    const result = await fs.readFile(path.join(root, 'game.ini'), 'utf8');
    const network = result.slice(result.indexOf('[Network]'), result.indexOf('[Game]'));
    assert.match(network, /^Port=30012$/m);
    assert.match(result, /^Name=x$/m);
    // The appended key must land under a [Network] header, not after [Game].
    assert.match(result.slice(result.lastIndexOf('[Network]')), /QueryPort=30013/);
  });

  await t.test('refuses to write outside the server directory', async () => {
    const root = await scratch();
    const outside = path.join(root, '..', 'escaped.properties');
    await fs.rm(outside, { force: true });

    // The guard throws, applyConfigFiles swallows it, and nothing is written.
    await applyConfigFiles(
      root,
      [{ path: '../escaped.properties', parser: 'properties', find: { a: 'b' } }],
      log,
    );

    await assert.rejects(fs.access(outside));
  });

  await t.test('leaves a file alone when nothing would change', async () => {
    const root = await scratch();
    const target = path.join(root, 'server.properties');
    await fs.writeFile(target, 'server-port=30012\n');
    const before = await fs.stat(target);

    await applyConfigFiles(
      root,
      [{ path: 'server.properties', parser: 'properties', find: { 'server-port': '30012' } }],
      log,
    );

    const after = await fs.stat(target);
    assert.equal(before.mtimeMs, after.mtimeMs);
  });
});
