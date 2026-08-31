import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentServerSpec } from '@storm/types';
import { DockerService } from '../src/services/docker.service.js';

/**
 * The container a customer gets console access to.
 *
 * They can run anything they like inside it, so the boundary is entirely in how
 * it is created: no privileges, no capabilities beyond what a game server
 * genuinely needs, no host path but their own directory, and not root. None of
 * that is visible in a running panel — a line dropped here while debugging
 * would hand every customer the host, and nothing would look different.
 */
describe('what a customer container is allowed', () => {
  const SPEC: AgentServerSpec = {
    uuid: '11111111-2222-3333-4444-555555555555',
    image: 'eclipse-temurin:25-jre',
    startupCommand: 'java -jar server.jar',
    environment: { SERVER_PORT: '25565' },
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

  /** Builds the container config the agent would send, without a daemon. */
  async function configFor(spec: AgentServerSpec): Promise<Record<string, any>> {
    const service = Object.create(DockerService.prototype) as DockerService;
    const internals = service as unknown as Record<string, unknown>;

    let captured: Record<string, any> | null = null;
    internals.options = { network: 'storm_net', dataDirectory: '/var/lib/storm/servers' };
    internals.nofileLimit = 4096;
    const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    internals.log = { ...quiet, child: () => quiet };
    internals.ensureImage = async () => undefined;
    internals.removeContainer = async () => undefined;
    internals.docker = {
      // The network already exists on a node the installer set up.
      listNetworks: async () => [{ Name: 'storm_net' }],
      createContainer: async (config: Record<string, any>) => {
        captured = config;
        return { id: 'deadbeef' };
      },
    };

    await service.createContainer(spec);
    assert.ok(captured, 'no container config was built');
    return captured;
  }

  it('never runs privileged, and never lets a process gain more', async () => {
    const config = await configFor(SPEC);
    assert.equal(config.HostConfig.Privileged, false);
    assert.deepEqual(config.HostConfig.SecurityOpt, ['no-new-privileges']);
  });

  it('drops every capability, and adds back only what a game server needs', async () => {
    const config = await configFor(SPEC);
    assert.deepEqual(config.HostConfig.CapDrop, ['ALL']);

    // Anything here is a deliberate grant. SYS_ADMIN, SYS_PTRACE, MKNOD and
    // friends are ways out of a container, not things a game server wants.
    for (const forbidden of ['SYS_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'MKNOD', 'NET_ADMIN']) {
      assert.equal(
        (config.HostConfig.CapAdd as string[]).includes(forbidden),
        false,
        `${forbidden} granted to a customer container`,
      );
    }
  });

  it('runs as an unprivileged user', async () => {
    const config = await configFor(SPEC);
    assert.equal(config.User, '1000:1000');
    assert.notEqual(config.User, '0:0');
  });

  it('mounts the server’s own directory and nothing else', async () => {
    const config = await configFor(SPEC);
    const binds = config.HostConfig.Binds as string[];

    assert.equal(binds.length, 1, `more than the server directory is mounted: ${binds.join(', ')}`);
    assert.match(binds[0] as string, new RegExp(`${SPEC.uuid}:/home/container:rw$`));

    // The socket is the whole game: a customer who can talk to Docker owns the
    // machine and every other customer's server on it.
    for (const bind of binds) {
      assert.doesNotMatch(bind, /docker\.sock/, 'the Docker socket is mounted into a container');
      assert.doesNotMatch(
        bind,
        /^\/(etc|root|proc|sys|var\/run)[/:]/,
        `host path mounted: ${bind}`,
      );
    }
  });

  it('caps processes and memory, so one server cannot take the node down', async () => {
    const config = await configFor(SPEC);
    assert.equal(config.HostConfig.PidsLimit, 256);
    assert.equal(config.HostConfig.Memory, 2048 * 1024 * 1024);
    assert.ok(config.HostConfig.LogConfig.Config['max-size'], 'logs are unbounded');
  });

  it('does not let a container restart itself out of a stopped state', async () => {
    // The panel decides when a server runs; a restart policy would fight it.
    const config = await configFor(SPEC);
    assert.equal(config.HostConfig.RestartPolicy.Name, 'no');
  });

  it('keeps /tmp free of setuid binaries', async () => {
    const config = await configFor(SPEC);
    assert.match(String(config.HostConfig.Tmpfs['/tmp']), /nosuid/);
  });

  it('publishes only the ports the panel allocated', async () => {
    const config = await configFor(SPEC);
    assert.deepEqual(Object.keys(config.HostConfig.PortBindings), ['25565/tcp']);
    assert.equal(config.HostConfig.PublishAllPorts, undefined);
  });
});
