import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import type { AgentServerSpec } from '@storm/types';
import { DockerService } from '../src/services/docker.service.js';

/**
 * Which resolvers the agent's containers get.
 *
 * A node whose own DNS does not reach the containers on it produces a failure
 * that names nothing near the panel: the install script simply cannot reach
 * where it downloads from, and what an operator reads is
 *
 *   java.net.UnknownHostException: launcher.mojang.com
 *
 * in the middle of a Java stack trace. The usual cause is a host running
 * systemd-resolved — `/etc/resolv.conf` holds only the 127.0.0.53 stub, Docker
 * will not hand a loopback address to a container and falls back to 8.8.8.8,
 * and a provider that filters outbound 53 leaves every container on the machine
 * with no resolution at all.
 *
 * The agent had no way to say otherwise. It has one now, and the default is
 * still to say nothing: Docker's arrangement is right on a host that is right,
 * and forcing public resolvers on everybody would break the operator running an
 * internal one on purpose.
 */
describe('the resolvers a container is given', () => {
  const SPEC: AgentServerSpec = {
    uuid: '11111111-2222-3333-4444-555555555555',
    image: 'eclipse-temurin:25-jre',
    startupCommand: 'java -jar server.jar',
    environment: {},
    ports: [{ ip: '0.0.0.0', port: 25565, containerPort: 25565, protocol: 'tcp' }],
    limits: {
      memoryMb: 2048,
      swapMb: 0,
      cpuPercent: 100,
      ioWeight: 500,
      pidsLimit: 256,
      oomKill: true,
    },
    labels: {},
  } as unknown as AgentServerSpec;

  /** The config the agent would send for a game container. */
  async function gameConfig(dns: string[]): Promise<Record<string, any>> {
    const service = Object.create(DockerService.prototype) as DockerService;
    const internals = service as unknown as Record<string, unknown>;

    let captured: Record<string, any> | null = null;
    internals.options = { network: 'storm_net', dataDirectory: '/var/lib/storm/servers', dns };
    internals.nofileLimit = 4096;
    const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    internals.log = { ...quiet, child: () => quiet };
    internals.ensureImage = async () => undefined;
    internals.removeContainer = async () => undefined;
    internals.docker = {
      listNetworks: async () => [{ Name: 'storm_net' }],
      createContainer: async (config: Record<string, any>) => {
        captured = config;
        return { id: 'deadbeef' };
      },
    };

    await service.createContainer(SPEC);
    assert.ok(captured, 'no container config was built');
    return captured;
  }

  /** The config the agent would send for a disposable install container. */
  async function installConfig(dns: string[]): Promise<Record<string, any>> {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'storm-dns-'));
    const service = Object.create(DockerService.prototype) as DockerService;
    const internals = service as unknown as Record<string, unknown>;

    let captured: Record<string, any> | null = null;
    internals.options = { network: 'storm_net', dataDirectory, dns };
    const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    internals.log = { ...quiet, child: () => quiet };
    internals.ensureImage = async () => undefined;
    internals.docker = {
      getContainer: () => ({ remove: async () => undefined }),
      modem: { demuxStream: () => undefined },
      createContainer: async (config: Record<string, any>) => {
        captured = config;
        return {
          attach: async () => new PassThrough(),
          start: async () => undefined,
          wait: async () => ({ StatusCode: 0 }),
          logs: async () => Buffer.from(''),
          remove: async () => undefined,
        };
      },
    };

    await service.runInstall(
      SPEC.uuid,
      { container: 'alpine', entrypoint: 'sh', script: 'echo hi', environment: {} },
      () => undefined,
    );
    await fs.rm(dataDirectory, { recursive: true, force: true });
    assert.ok(captured, 'no install container config was built');
    return captured;
  }

  it('says nothing by default, leaving Docker its own arrangement', async () => {
    // The default has to be inert. An agent that started overriding DNS on
    // upgrade would break every node whose resolver is deliberate.
    const config = await gameConfig([]);
    assert.equal('Dns' in config.HostConfig, false, JSON.stringify(config.HostConfig.Dns));
  });

  it('says nothing by default for an install container either', async () => {
    const config = await installConfig([]);
    assert.equal('Dns' in config.HostConfig, false);
  });

  it('passes the configured resolvers to a game container', async () => {
    const config = await gameConfig(['1.1.1.1', '1.0.0.1']);
    assert.deepEqual(config.HostConfig.Dns, ['1.1.1.1', '1.0.0.1']);
  });

  it('passes them to the install container, which is where downloads happen', async () => {
    // This is the container that failed. A lever that reached only the game
    // container would have fixed nothing about the install that reported it.
    const config = await installConfig(['1.1.1.1', '1.0.0.1']);
    assert.deepEqual(config.HostConfig.Dns, ['1.1.1.1', '1.0.0.1']);
  });

  it('keeps the hardening it already had while doing so', async () => {
    // Adding a key to HostConfig is exactly the kind of edit that drops the
    // one below it.
    const config = await installConfig(['1.1.1.1']);
    assert.deepEqual(config.HostConfig.CapDrop, ['ALL']);
    assert.deepEqual(config.HostConfig.SecurityOpt, ['no-new-privileges']);
    assert.equal(config.HostConfig.NetworkMode, 'bridge');
  });
});
